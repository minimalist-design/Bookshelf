// Loaded before every test file (bunfig.toml): tests never use a real ISBNdb key from the environment
// (or a .env file); the ones that need ISBNdb pass a fake key of their own.
delete process.env.ISBNDB_API_KEY;
