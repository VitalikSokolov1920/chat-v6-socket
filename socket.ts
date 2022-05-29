import * as dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import * as jwt from 'jsonwebtoken';
import {Server, Socket} from 'socket.io';

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    maxPreparedStatements: Number(process.env.MAX_CONNECTIONS),
});

const socket = new Server(3001, {
    cors: {
        origin: '*'
    }
});

const idSocket = new Map<string, Socket>();
const socketId = new Map<Socket, string>();

function cacheUserInfo(socket: Socket, id: string) {
    idSocket.set(id, socket);
    socketId.set(socket, id);

}

function getUserId(socket: Socket) {
    return socketId.get(socket);
}

function getSocket(id: string) {
    return idSocket.get(id);
}

function clearUserInfo(socket: Socket) {
    const id = socketId.get(socket) as string;

    pool.query(`DELETE FROM online_user WHERE id=?`, [id]);

    socketId.delete(socket);
    idSocket.delete(id);

    if (socket.connected) {
        socket.disconnect();
    }
}

function checkJwt(params: any, socket: Socket) {
    const token = params.token;

    if (!token) {
        clearUserInfo(socket);
    } else {
        try {
            jwt.verify(token, process.env.PRIVATE_KEY as string);
        } catch (err) {
            console.log('DISCONNECT! DOES NOT EXIST JWT TOKEN!');
            clearUserInfo(socket);
        }
    }
}

socket.on('connection', (socket) => {
    console.log('SOCKET CONNECTED');

    socket.emit('userId');

    socket.on('userId', (params) => {
        const id = params.id;

        checkJwt(params, socket);

        console.log(`CONNECT ID: ${id}`);

        cacheUserInfo(socket, id);
    });

    socket.on('sendMessage', (params) => {
        checkJwt(params, socket);

        const message_text = params.message_text;
        const send_from_id = params.send_from_id;
        const send_to_id = params.send_to_id;
        const is_read = false;

        pool.query(`INSERT INTO message (send_from_id, send_to_id, is_read, message_text) 
            VALUES (?, ?, ?, ?)`, [send_from_id, send_to_id, is_read, message_text]).then(result => {

            const insert = result[0] as any;

            if (insert.affectedRows != 0) {
                pool.query(`SELECT * FROM message WHERE id = ?`, [insert.insertId]).then(result => {
                    const message = (result[0] as any)[0];

                    socket.emit('message', message);

                    const otherSocket = getSocket(message.send_to_id);

                    if (otherSocket) {
                        otherSocket.emit('message', message);
                    }

                    pool.query(`
                        SELECT count(*) as unread_messages_amount_sending_socket FROM message WHERE send_from_id=? AND send_to_id=? AND is_read=FALSE`,
                        [message.send_to_id, message.send_from_id]).then(result => {
                        const unread_messages_amount_sending_socket = (result[0] as any)[0].unread_messages_amount_sending_socket;

                        const lastMessageInfoToSendingSocket = {
                            send_from_id: message.send_from_id,
                            send_to_id: message.send_to_id,
                            last_message: message.message_text,
                            timestamp: message.timestamp,
                            unread_messages_amount: unread_messages_amount_sending_socket,
                            toSendingSocket: true,
                        }

                        socket.emit('changeLastMessage', lastMessageInfoToSendingSocket);
                    });

                    if (otherSocket) {
                        pool.query(`
                        SELECT count(*) as unread_messages_amount_geting_socket FROM message WHERE send_from_id=? AND send_to_id=? AND is_read=FALSE`,
                            [message.send_from_id, message.send_to_id]).then(result => {
                            const unread_messages_amount_geting_socket = (result[0] as any)[0].unread_messages_amount_geting_socket;

                            const lastMessageInfoToGetingSocket = {
                                send_from_id: message.send_from_id,
                                send_to_id: message.send_to_id,
                                last_message: message.message_text,
                                timestamp: message.timestamp,
                                unread_messages_amount: unread_messages_amount_geting_socket,
                                toSendingSocket: false,
                            };

                            otherSocket.emit('changeLastMessage', lastMessageInfoToGetingSocket);
                        });
                    }
                });
            }
        });
    });

    socket.on('allMessagesRead', (params) => {
        checkJwt(params, socket);

        const {otherUserId} = params;
        const authUserId = socketId.get(socket);

        pool.query(`UPDATE message SET is_read=TRUE WHERE send_to_id=? AND send_From_id=? AND is_read=FALSE`, [authUserId, otherUserId]).then(result => {
            socket.emit('allMessagesRead', {
                toSendSocket: true,
                otherUserId: otherUserId,
                authUserId: authUserId,
            });

            const otherSocket = idSocket.get(otherUserId);

            if (otherSocket) {
                otherSocket.emit('allMessagesRead', {
                    toSendSocket: false,
                    otherUserId: authUserId,
                    authUserId: otherUserId
                });
            }
        });
    });

    socket.on('messageRead', (params) => {
        checkJwt(params, socket);

        const { messageId, sendFromId, sendToId } = params;

        pool.query(`UPDATE message SET is_read=TRUE WHERE id=?`, [messageId]).then(result => {
           socket.emit('messageRead', messageId);

           pool.query(`SELECT count(*) as amount FROM message WHERE send_from_id=? AND send_to_id=? AND is_read=FALSE`, [sendToId, sendFromId]).then(result => {
               const amount = (result[0] as any)[0].amount;

               socket.emit('changeUnreadMessagesAmount', {
                   unreadMessagesAmount: amount,
                   sendFromId,
                   sendToId
               });
           })

           pool.query(`SELECT send_from_id FROM message WHERE id=?`, [messageId]).then(result => {
               const send_from_id = (result[0] as any)[0].send_from_id;

               const otherSocket = idSocket.get(send_from_id);

               if (otherSocket) {
                   otherSocket.emit('messageRead', messageId);
               }
           });
        });
    });

    socket.on('disconnect', () => {
        console.log(`SOCKET DISCONNECTED`);

        clearUserInfo(socket);
    });
});
