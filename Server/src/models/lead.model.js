import mongoose from "mongoose";

const leadSchema = new mongoose.Schema(
  {
    // Unique Lead Identification
    leadId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      index: true,
    },
    leadNumber: {
      type: Number,
      sparse: true,
      index: true,
    },
    leadPrefix: {
      type: String,
      default: "LEAD",
      trim: true,
    },

    // Name is compulsory
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },

    phone: {
      type: String,
      trim: true,
      required: [true, "Phone number is required"],
      match: [/^\d{10}$/, "Phone number must be a valid 10-digit number"],
    },

    // Status
    status: {
      type: String,
      enum: [
        "New",
        "Contacted",
        "Interested",
        "Contact Tomorrow",
        "Contact in 2 Days",
        "Come for Visit",
        "Shared Quotation",
        "Negotiation",
        "Follow Up (Custom)",
        "Not Interested",
        "Need to message",
        "Converted",
        "Lost",
      ],
      default: "New",
    },

    // Source
    source: {
      type: String,
      trim: true,
      enum: ["Instagram",
        "WhatsApp",
        "Walk-in",
        "Reference",
        "Member",
        "Events",
        "Website",
        "Other",],
      default: "",
    },

    // Purpose
    purpose: {
      type: String,
      trim: true,
      enum: ["Events",
        "Supplies",
        "Space Booking (Exhibition)",
        "Space Booking (Corporate Booking)",
        "Framing",
        "Private Booking",
        "Birthday Party",
        "Membership",
        "Volunteering",
        "CSP",
        "Hiring",
        "Customer Art Work",
        "Co-Working",
        "Handmade Gift",
        "Atives",
        "Woorkshop",
        "Exhibition",
        "Other",],
      default: "",
    },

    deadline:{
      type:Date,
      default: null,
    },

    // Reason / Note
    reasonNote: {
      type: String,
      trim: true,
      default: "",
    },

    // Media / Document Attachments
    attachments: [
      {
        url: { type: String, required: true },
        name: { type: String, default: "" },
        mimeType: { type: String, default: "" },
        size: { type: Number, default: 0 },
      },
    ],

    // Reference URL / Media Link
    url: {
      type: String,
      trim: true,
      default: "",
    },

    // Created By Staff
    createdBy: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
      m_staff_email: { type: String, default: null },
    },

    // Assigned To Staff
    assignedTo: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
      m_staff_email: { type: String, default: null },
    },

    // Lead date
    date: {
      type: Date,
      default: Date.now,
    },

    timeline: [
      {
        type: {
          type: String,
          enum: ["created", "status"],
          default: "status",
        },
        title: { type: String, default: "", trim: true },
        status: { type: String, default: "", trim: true },
        note: { type: String, default: "", trim: true },
        followUpAt: { type: Date, default: null },
        reminderTime: { type: String, default: "", trim: true },
        at: { type: Date, default: Date.now },
        by: {
          m_staff_id: { type: String, default: null },
          m_staff_name: { type: String, default: null },
          m_staff_email: { type: String, default: null },
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);


leadSchema.pre("validate", function (next) {
  const phone = this.phone?.trim();

  if (!phone) {
    this.invalidate("phone", "Phone number is required.");
  } else if (!/^\d{10}$/.test(phone)) {
    this.invalidate("phone", "Phone number must be a valid 10-digit number.");
  }

  next();
});


const Lead = mongoose.model("Lead", leadSchema);

export default Lead;