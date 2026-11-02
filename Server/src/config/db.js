
import mongoose from "mongoose";

let connectionPromise = null;

const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return;

  // A dropped connection must start a new attempt. An in-flight one is reused.
  if (mongoose.connection.readyState === 0) {
    connectionPromise = null;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(process.env.MONGODB_URI, {
        bufferCommands: false,
        serverSelectionTimeoutMS: 10000,
      })
      .then(() => {
        console.log("✅ MongoDB connected successfully!");
      })
      .catch((error) => {
        connectionPromise = null;
        console.error("❌ MongoDB connection failed:", error.message);
        throw error;
      });
  }

  await connectionPromise;
};

export default connectDB;
