/**
 * Global error handling middleware.
 * Must be registered LAST in Express middleware chain.
 */
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";

  // PostgreSQL unique violation (e.g. duplicate email/username)
  if (err.code === "23505") {
    const field = (err.constraint || "").replace(/^users_|_key$/g, "") || "Value";
    message = `${field.charAt(0).toUpperCase() + field.slice(1)} already exists.`;
    statusCode = 409;
  }

  // PostgreSQL invalid input (e.g. malformed UUID in a URL parameter)
  if (err.code === "22P02") {
    message = "Invalid ID.";
    statusCode = 400;
  }

  // PostgreSQL check / not-null / length violations
  if (["23514", "23502", "22001"].includes(err.code)) {
    message = "Invalid input.";
    statusCode = 400;
  }

  // Referenced row does not exist (e.g. unknown receiverId)
  if (err.code === "23503") {
    message = "Referenced record not found.";
    statusCode = 404;
  }

  if (statusCode >= 500) {
    console.error("Unhandled error:", err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = { errorHandler };
