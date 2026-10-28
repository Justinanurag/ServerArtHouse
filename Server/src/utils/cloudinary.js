import {v2 as cloudinary} from 'cloudinary';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure CLOUDINARY_URL is loaded even if this module is imported early
dotenv.config({path: path.resolve(__dirname, '../.env')});

/**
 * Upload a local temp file to Cloudinary and return the secure HTTPS URL.
 * Uses CLOUDINARY_URL from env (cloudinary://API_KEY:API_SECRET@CLOUD_NAME).
 */
export const uploadOnCloudinary = async (localFilePath, options = {}) => {
  try {
    if (!localFilePath) return null;

    if (!process.env.CLOUDINARY_URL) {
      console.warn(
        'CLOUDINARY_URL not found in env — skipping Cloudinary upload.',
      );
      return null;
    }

    // Reload config from CLOUDINARY_URL
    cloudinary.config(true);

    const response = await cloudinary.uploader.upload(localFilePath, {
      resource_type: 'auto',
      folder: options.folder || 'woowoo',
    });

    try {
      if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
    } catch (err) {
      console.error('Error deleting local file after Cloudinary upload:', err);
    }

    return response?.secure_url || response?.url || null;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    try {
      if (localFilePath && fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
    } catch (err) {
      console.error('Error deleting local file after Cloudinary failure:', err);
    }
    return null;
  }
};
