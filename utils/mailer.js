const nodemailer = require("nodemailer");

/**
 * Gmail SMTP via an App Password (Google Account → Security → App passwords).
 * EMAIL_USER = the Gmail address, EMAIL_PASS = the 16-character app password.
 */
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("EMAIL_USER and EMAIL_PASS must be set in environment variables");
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS.replace(/\s+/g, ""),
    },
  });
  return transporter;
};

const codeEmailHtml = ({ heading, intro, code, minutes, footnote }) => `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0B0F1A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0F1A;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#131A2B;border-radius:20px;border:1px solid #232C42;">
            <tr>
              <td style="padding:36px 32px 8px;text-align:center;">
                <div style="display:inline-block;width:52px;height:52px;line-height:52px;border-radius:16px;background:linear-gradient(135deg,#7C5CFF,#4F8BFF);color:#fff;font-size:24px;font-weight:700;">F</div>
                <h1 style="margin:20px 0 8px;color:#F4F6FB;font-size:22px;font-weight:700;">${heading}</h1>
                <p style="margin:0;color:#98A2B8;font-size:15px;line-height:22px;">${intro}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;text-align:center;">
                <div style="display:inline-block;padding:16px 28px;border-radius:14px;background:#0B0F1A;border:1px solid #2E3854;color:#FFFFFF;font-size:32px;font-weight:700;letter-spacing:10px;">${code}</div>
                <p style="margin:16px 0 0;color:#98A2B8;font-size:13px;">This code expires in ${minutes} minutes.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px;text-align:center;">
                <p style="margin:0;color:#6B7590;font-size:12px;line-height:18px;">${footnote}</p>
              </td>
            </tr>
          </table>
          <p style="margin:20px 0 0;color:#4A5370;font-size:12px;">Fast Chat · Real-time messaging</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

const send = async ({ to, subject, html, text }) => {
  const info = await getTransporter().sendMail({
    from: { name: "Fast Chat", address: process.env.EMAIL_USER },
    to,
    subject,
    html,
    text,
  });
  console.log(`📧 Email sent to ${to}: ${info.messageId}`);
  return info;
};

const sendOTPEmail = (toEmail, otp, minutes) =>
  send({
    to: toEmail,
    subject: `${otp} is your Fast Chat verification code`,
    text: `Your Fast Chat verification code is ${otp}. It expires in ${minutes} minutes.`,
    html: codeEmailHtml({
      heading: "Verify your email",
      intro: "Use this code to finish creating your Fast Chat account.",
      code: otp,
      minutes,
      footnote: "If you didn't try to sign up, you can safely ignore this email.",
    }),
  });

const sendPasswordResetEmail = (toEmail, otp, minutes) =>
  send({
    to: toEmail,
    subject: `${otp} is your Fast Chat password reset code`,
    text: `Your Fast Chat password reset code is ${otp}. It expires in ${minutes} minutes.`,
    html: codeEmailHtml({
      heading: "Reset your password",
      intro: "Enter this code in the app to choose a new password.",
      code: otp,
      minutes,
      footnote: "If you didn't request a password reset, ignore this email — your password stays the same.",
    }),
  });

module.exports = { sendOTPEmail, sendPasswordResetEmail };
