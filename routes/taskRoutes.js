const express = require("express");
const t = require("../controllers/taskController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(protect);
router.get("/", t.listTasks); // ?scope=mine|workspace&workspaceId=&status=&assigneeId=
router.post("/", t.createTask);
router.get("/:id", t.getTask);
router.patch("/:id", t.updateTask);
router.delete("/:id", t.deleteTask);
router.get("/:id/comments", t.listComments);
router.post("/:id/comments", t.addComment);
module.exports = router;
