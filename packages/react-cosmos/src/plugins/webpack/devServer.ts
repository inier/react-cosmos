import webpackHotMiddleware from '@skidding/webpack-hot-middleware';
import { NextHandleFunction } from 'connect';
import path from 'path';
import { BuildMessage } from 'react-cosmos-shared2/build';
import webpack from 'webpack';
import webpackDevMiddleware from 'webpack-dev-middleware';
import { DevServerPluginArgs } from '../../shared/devServer';
import { removeLeadingDot } from '../../shared/shared';
import { serveStaticDir } from '../../shared/static';
import { createWebpackCosmosConfig } from './cosmosConfig/webpack';
import { getWebpack } from './shared';
import { getDevWebpackConfig } from './webpackConfig';

type WebpackConfig = webpack.Configuration & {
  // webpack-dev-server options (no need to install WDS just for these types)
  devServer: {
    contentBase: string;
  };
};

type WebpackDevMiddlewareInstance = NextHandleFunction & {
  close: (callback?: () => void) => unknown;
};

type WebpackDevMiddleware = (
  compiler: webpack.ICompiler,
  options?: webpackDevMiddleware.Options
) => WebpackDevMiddlewareInstance;

export async function webpackDevServer({
  cosmosConfig,
  expressApp,
  sendMessage,
}: DevServerPluginArgs) {
  const userWebpack = getWebpack(cosmosConfig.rootDir);
  if (!userWebpack) {
    return;
  }

  const webpackConfig = (await getDevWebpackConfig(
    cosmosConfig,
    userWebpack
  )) as WebpackConfig;

  // Serve static path derived from devServer.contentBase webpack config
  if (cosmosConfig.staticPath === null) {
    const webpackDerivedStaticPath = getWebpackStaticPath(webpackConfig);
    if (webpackDerivedStaticPath !== null) {
      serveStaticDir(
        expressApp,
        path.resolve(cosmosConfig.rootDir, webpackDerivedStaticPath),
        cosmosConfig.publicUrl
      );
    }
  }

  function sendBuildMessage(msg: BuildMessage) {
    sendMessage(msg);
  }

  const webpackCompiler = userWebpack(webpackConfig);
  webpackCompiler.hooks.invalid.tap('Cosmos', filePath => {
    const relFilePath = path.relative(process.cwd(), filePath);
    console.log('[Cosmos] webpack build invalidated by', relFilePath);
    sendBuildMessage({ type: 'buildStart' });
  });
  webpackCompiler.hooks.failed.tap('Cosmos', () => {
    sendBuildMessage({ type: 'buildError' });
  });
  const onCompilationDone: Promise<void> = new Promise(resolve => {
    webpackCompiler.hooks.done.tap('Cosmos', stats => {
      resolve();
      if (stats.hasErrors()) {
        sendBuildMessage({ type: 'buildError' });
      } else {
        sendBuildMessage({ type: 'buildDone' });
      }
    });
  });

  console.log('[Cosmos] Building webpack...');

  // Why import WDM here instead of at module level? Because it imports webpack,
  // which might not be installed in the user's codebase. If this were to happen
  // the Cosmos server would crash with a cryptic import error. See import here:
  // https://github.com/webpack/webpack-dev-middleware/blob/eb2e32bab57df11bdfbbac19474eb16817d504fe/lib/fs.js#L8
  // Instead, prior to importing WDM we check if webpack is installed and fail
  // gracefully if not.
  const wdm: WebpackDevMiddleware = require('webpack-dev-middleware');
  const wdmInst = wdm(webpackCompiler, {
    // publicPath is the base path for the webpack assets and has to match
    // webpack.output.path
    publicPath: removeLeadingDot(cosmosConfig.publicUrl),
    logLevel: 'warn',
  });

  expressApp.use(wdmInst);

  const { hotReload } = createWebpackCosmosConfig(cosmosConfig);
  if (hotReload) {
    expressApp.use(webpackHotMiddleware(webpackCompiler));
  }

  await onCompilationDone;

  return async () => {
    await new Promise(res => wdmInst.close(res));
  };
}

function getWebpackStaticPath({ devServer }: WebpackConfig) {
  return devServer && typeof devServer.contentBase === 'string'
    ? devServer.contentBase
    : null;
}
