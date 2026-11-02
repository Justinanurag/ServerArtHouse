import mongoose from "mongoose";
import { ensureCustomerIndexes } from "../utils/ensureCustomerIndexes.js";

const cached =
  global.mongoose ||
  (global.mongoose = {
    conn: null,
    promise: null,
  });

const connectDB = async () => {
  // Reuse a healthy existing connection
  if (
    cached.conn &&
    mongoose.connection.readyState === 1
  ) {
    return cached.conn;
  }

  // Clear stale cached state when disconnected
  if (mongoose.connection.readyState === 0) {
    cached.conn = null;
    cached.promise = null;
  }

  // Reuse an in-progress connection attempt
  if (!cached.promise) {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      throw new Error("MONGODB_URI is not configured");
    }

    cached.promise = mongoose
      .connect(mongoUri, {
        bufferCommands: false,
        serverSelectionTimeoutMS: 10000,
      })
      .then(async (mongooseInstance) => {
        console.log("✅ MongoDB connected successfully!");

        try {
          await ensureCustomerIndexes(
            mongooseInstance.connection.db
          );
        } catch (error) {
          console.error(
            "Failed to ensure customer indexes:",
            error.message
          );
        }

        return mongooseInstance;
      })
      .catch((error) => {
        cached.conn = null;
        cached.promise = null;

        console.error(
          "❌ MongoDB connection failed:",
          error.message
        );

        throw error;
      });
  }

  cached.conn = await cached.promise;

  return cached.conn;
};

export default connectDB;