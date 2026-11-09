const { onlineUsers, userRoom } = require("../sockets/socketHandler");


const initiateCall = async (req, res) => {
    try {
        const { callerId, receiverId, channelName, callType } = req.body;

        if (!callerId || !receiverId || !channelName || !callType) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: callerId, receiverId, channelName, callType",
            });
        }

        const io = req.app.get("io");

        console.log(`DEBUG: Looking up receiverSocketId for receiverId: ${receiverId}`);
        console.log(`DEBUG: Available online users in map: ${Array.from(onlineUsers.keys())}`);

        if (onlineUsers.has(receiverId)) {
            // Emit incoming_call event to every device of the receiver
            io.to(userRoom(receiverId)).emit("incoming_call", {
                callerId,
                callerName: req.user.name, // Assuming req.user is populated by protect middleware
                channelName,
                callType,
            });

            return res.status(200).json({
                success: true,
                message: "Call initiated and receiver notified",
            });
        } else {
            return res.status(404).json({
                success: false,
                message: "Receiver is currently offline",
            });
        }
    } catch (error) {
        console.error("Error initiating call:", error.message);
        res.status(500).json({
            success: false,
            message: "Internal server error while initiating call",
        });
    }
};

/**
 * Ends a call and notifies both parties (via channel or userIds)
 * POST /api/call/end
 */
const endCall = async (req, res) => {
    try {
        const { channelName, userId, otherUserId } = req.body;

        if (!channelName) {
            return res.status(400).json({
                success: false,
                message: "channelName is required",
            });
        }

        const io = req.app.get("io");

        // Notify the other user if ID is provided
        if (otherUserId) {
            io.to(userRoom(otherUserId)).emit("call_ended", { channelName });
        }

        // Optionally notify the sender as well if they need confirmation via socket
        io.to(userRoom(userId || req.user.id)).emit("call_ended", { channelName });

        res.status(200).json({
            success: true,
            message: "Call ended successfully",
        });
    } catch (error) {
        console.error("Error ending call:", error.message);
        res.status(500).json({
            success: false,
            message: "Internal server error while ending call",
        });
    }
};

module.exports = {
    initiateCall,
    endCall,
};
