import mongoose from "mongoose";
import { ensureCustomerIndexes } from "../utils/ensureCustomerIndexes.js";

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null,
  };
}

const connectDB = async (attempt = 0) => {
  // Reuse an open connection across warm serverless invocations.
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  // Share one in-flight connect so concurrent requests do not open
  // multiple clients. Assign the promise before awaiting it.
  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
    };

    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, opts)
      .then(async (mongooseInstance) => {
        console.log("✅ MongoDB connected successfully!");

        try {
          await ensureCustomerIndexes(mongooseInstance.connection.db);
        } catch (error) {
          console.error(
            "Failed to ensure customer indexes:",
            error.message
          );
        }

        return mongooseInstance;
      })
      .catch((error) => {
        // Allow a future request to retry the connection
        cached.promise = null;
        cached.conn = null;
        throw error;
      });
  }

  cached.conn = await cached.promise;

  // A cached promise can resolve after the socket has already dropped.
  // Drop it and open a fresh connection instead of querying a dead client.
  if (mongoose.connection.readyState !== 1) {
    cached.promise = null;
    cached.conn = null;
    if (attempt >= 1) {
      throw new Error("MongoDB connection was not ready after connect()");
    }
    return connectDB(attempt + 1);
  }

  return cached.conn;
};

export default connectDB;