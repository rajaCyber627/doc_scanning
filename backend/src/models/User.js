const mongoose = require('mongoose');
const schema = mongoose.Schema(
    {
        firstName: String,
        lastName: String,
        userName: String,
        email: String,
        password: String,
        role: String,
        // Extra rights (until SSO + roles): e.g. "restricted" = may see medical/FMLA/ADA/WC/ER records
        permissions: { type: [String], default: [] },
        // Email-OTP two-step verification
        twoFactorEnabled: { type: Boolean, default: false },
        otp: String,
        otpExpires: Date,
        lastTwoFactorNudge: Date,
        // Standing instructions applied to every query (like ChatGPT custom instructions)
        customInstructions: { type: String, default: '' },
    },
    {timestamps: true}
)

const User = mongoose.model('User',schema);
module.exports = User;
