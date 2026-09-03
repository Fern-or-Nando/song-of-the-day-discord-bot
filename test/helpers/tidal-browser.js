function fakeTidalBrowser(metadata, options = {}) {
  const calls = { closed: 0, launches: 0 };
  const frame = {};
  const page = {
    mainFrame: () => frame,
    goto: async (url, settings) => {
      calls.url = url;
      calls.goto = settings;
      if (options.gotoError) throw options.gotoError;
      return { ok: () => !options.status || options.status < 400, status: () => options.status || 200 };
    },
    waitForFunction: async () => {
      if (options.waitError) throw options.waitError;
    },
    evaluate: async () => metadata,
    url: () => options.finalUrl || calls.url
  };
  const browserType = {
    launch: async settings => {
      calls.launches += 1;
      calls.launch = settings;
      if (options.launchError) throw options.launchError;
      return {
        newContext: async settings => {
          calls.context = settings;
          return {
            route: async (_, handler) => { calls.route = handler; },
            newPage: async () => page
          };
        },
        close: async () => { calls.closed += 1; }
      };
    }
  };
  return { browserType, calls, page, frame };
}

module.exports = { fakeTidalBrowser };
