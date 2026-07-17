export function createServerStarter({
  defaultPort,
  defaultListen,
  defaultInitialize,
  onListening = () => {},
}) {
  return function startServer({
    port = defaultPort,
    listen = defaultListen,
    initialize = defaultInitialize,
  } = {}) {
    return new Promise((resolve, reject) => {
      let server;
      let settled = false;

      const cleanup = () => server?.removeListener?.('error', onError);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = (error) => fail(error);

      const onListeningCallback = async (legacyError) => {
        // Node's listen callback receives no arguments. Retain this guard for
        // injected adapters while the runtime contract is the error event.
        if (legacyError instanceof Error) {
          fail(legacyError);
          return;
        }
        try {
          onListening(port);
          await initialize();
          if (settled) return;
          settled = true;
          cleanup();
          resolve(server);
        } catch (error) {
          server?.close?.();
          fail(error);
        }
      };

      try {
        server = listen(port, onListeningCallback);
        server?.once?.('error', onError);
      } catch (error) {
        fail(error);
      }
    });
  };
}
