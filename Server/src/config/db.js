import mongoose from "mongoose";
import { ensureCustomerIndexes } from "../utils/ensureCustomerIndexes.js";

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null,
  };
}

const connectDB = async () => {
  // Reuse existing connection
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  // Reuse existing connection promise if connection is in progress
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
        throw error;
      });
  }

  cached.conn = await cached.promise;

  return cached.conn;
};

export default connectDB;