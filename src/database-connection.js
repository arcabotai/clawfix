export function createHyperdriveDatabase(Client, connectionString) {
  function createClient() {
    return new Client({ connectionString });
  }

  return {
    async query(text, values) {
      const client = createClient();
      await client.connect();
      try {
        return await client.query(text, values);
      } finally {
        await client.end();
      }
    },

    async connect() {
      const client = createClient();
      await client.connect();
      let released = false;
      return {
        query: client.query.bind(client),
        async release() {
          if (released) return;
          await client.end();
          released = true;
        },
      };
    },
  };
}
