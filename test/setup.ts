// Load .env for tests (Vitest does not read it on its own).
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the environment.
}
