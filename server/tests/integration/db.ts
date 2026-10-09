import os from 'node:os';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Integration tests run against a real MongoDB. By default they start a throwaway in-memory
 * server (downloaded once and cached). To reuse the Docker database instead, run:
 *   MONGODB_TEST_URI=mongodb://localhost:27017/claimcheck_test npm test
 * The test database is wiped between tests, so never point this at the real claimcheck database.
 */
let memory: MongoMemoryServer | undefined;

export async function connectTestDb() {
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    // require (not import()) because Jest runs CommonJS without experimental ESM support.
    const { MongoMemoryServer } = require('mongodb-memory-server') as typeof import('mongodb-memory-server');
    memory = await MongoMemoryServer.create();
    uri = memory.getUri();
  }
  // Each Jest worker gets its own database, so test files running in parallel never collide,
  // and the main "claimcheck" database is never touched.
  await mongoose.connect(uri, {
    dbName: `claimcheck_test_${process.env.JEST_WORKER_ID ?? '1'}`,
    serverSelectionTimeoutMS: 5000, // fail in seconds, not minutes, if MongoDB is unreachable
    // The MongoDB driver loads `os` with a dynamic import(), which Jest's CommonJS runtime rejects.
    // Without it, the driver's handshake metadata comes out empty and the server refuses the
    // connection ("Missing required sub-document 'driver'"). Passing the module in avoids that.
    runtimeAdapters: { os },
  });
}

export async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await memory?.stop();
}
