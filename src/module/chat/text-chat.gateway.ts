import {
  UseFilters,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ConnectedSocket,
  GatewayMetadata,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { instanceToPlain } from 'class-transformer';
import { Server, Socket } from 'socket.io';
import { CORSConfig, ValidationConfig } from 'src/config';
import { ActiveStatus, EmitEvent, ListenEvent, RoomEvent } from 'src/enum';
import { WsExceptionsFilter } from 'src/filter';
import {
  EventNameBindingInterceptor,
  SocketUserIdBindingInterceptor,
} from 'src/interceptor';
import { UserService } from 'src/service/user.service';
import { EmitEvents } from 'src/type';
import {
  InviteToRoomDto,
  JoinRoomDto,
  KickOutOfRoomDto,
  LeaveRoomDto,
  RespondInvitationDto,
  SendGroupMessageDto,
  SendPrivateMessageDto,
  TransferOwnershipDto,
} from './dto';
import { ConnectionService } from './service/connection.service';
import { MessageService } from './service/message.service';
import { RoomService } from './service/room.service';

@UseFilters(new WsExceptionsFilter())
@UsePipes(new ValidationPipe(ValidationConfig))
@WebSocketGateway<GatewayMetadata>({
  namespace: 'text',
  cors: CORSConfig,
})
export class TextChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private readonly server: Server<null, EmitEvents>;

  constructor(
    private userService: UserService,
    private connectionService: ConnectionService,
    private messageService: MessageService,
    private roomService: RoomService,
  ) {}

  /**
   * Store user state before connection.
   *
   * @param client socket client.
   */
  async handleConnection(client: Socket<null, EmitEvents>) {
    try {
      const user = await this.connectionService.validateConnection(
        this.server,
        client,
      );
      await this.userService.connect(user, client.id);

      const friendsSids = await this.userService.getOnlineFriendsSocketIds(
        user.id,
      );
      friendsSids.forEach((sids) => client.to(sids));
      client.emit(EmitEvent.UpdateFriendStatus, {
        id: user.id,
        status: ActiveStatus.Online,
      });
    } catch (error: any) {
      client.emit(EmitEvent.Error, {
        event: ListenEvent.Connect,
        message: error.message,
      });

      client.disconnect();
    }
  }

  /**
   * Remove user state after disconnection.
   *
   * @param client socket client.
   */
  async handleDisconnect(client: Socket<null, EmitEvents>) {
    const user = await this.userService.getBySocketId(client.id);

    if (user != null) {
      await this.userService.disconnect(user, client.id);

      const friendsSids = await this.userService.getOnlineFriendsSocketIds(
        user.id,
      );

      friendsSids.forEach((sids) => client.to(sids));
      client.emit(EmitEvent.UpdateFriendStatus, {
        id: user.id,
        status: null,
      });
    }
  }

  /**
   * Send private message.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.SendPrivateMessage),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.SendPrivateMessage)
  async sendPrivateMessage(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    @MessageBody() payload: SendPrivateMessageDto,
  ) {
    if (
      !(await this.userService.areFriends(client.userId, payload.receiverId))
    ) {
      throw new WsException('Only friends can send messages to each other!');
    }

    await this.messageService.createPrivateMessage(client.userId, payload);
    const sids = await this.userService.getSocketIds(payload.receiverId);

    this.server.to(sids as string[]).emit(EmitEvent.ReceivePrivateMessage, {
      ...(instanceToPlain(payload) as SendGroupMessageDto),
      senderId: client.userId,
    });
  }

  /**
   * Create a new room.
   *
   * @param client socket client.
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.CreateRoom),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.CreateRoom)
  async handleCreateRoom(@ConnectedSocket() client: Socket<null, EmitEvents>) {
    const room = await this.roomService.book(client.userId);
    client.join(room.id);

    client.emit(EmitEvent.ReceiveRoomChanges, {
      event: RoomEvent.Create,
      actorId: client.userId,
      room: {
        id: room.id,
      },
    });
  }

  /**
   * Join to a new room.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.JoinRoom),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.JoinRoom)
  async handleJoinRoom(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: JoinRoomDto,
  ) {
    const room = await this.roomService.join(payload.roomId, client.userId);
    client.join(room.id);

    this.server.to(room.id).emit(EmitEvent.ReceiveRoomChanges, {
      event: RoomEvent.Join,
      actorId: client.userId,
      room: {
        id: room.id,
        memberIds: room.memberIds,
        waitingIds: room.waitingIds,
        refusedIds: room.refusedIds,
      },
    });
  }

  /**
   * Leave the room.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.LeaveRoom),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.LeaveRoom)
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: LeaveRoomDto,
  ) {
    const room = await this.roomService.leave(payload.roomId, client.userId);
    client.leave(room.id);

    this.server
      .to(client.id)
      .to(room.id)
      .emit(EmitEvent.ReceiveRoomChanges, {
        event: RoomEvent.Leave,
        actorId: client.userId,
        room: {
          id: room.id,
          memberIds: room.memberIds,
        },
      });
  }

  /**
   * Kick member out of room.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.KickOutOfRoom),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.KickOutOfRoom)
  async handleKickOutOfRoom(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: KickOutOfRoomDto,
  ) {
    const room = await this.roomService.kick(
      payload.roomId,
      client.userId,
      payload.memberId,
    );
    client.leave(room.id);

    this.server
      .to(client.id)
      .to(room.id)
      .emit(EmitEvent.ReceiveRoomChanges, {
        event: RoomEvent.Kick,
        actorId: client.userId,
        room: {
          id: room.id,
          memberIds: room.memberIds,
        },
      });
  }

  /**
   * Send group message.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.SendGroupMessage),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.SendGroupMessage)
  async handleSendGroupMessage(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: SendGroupMessageDto,
  ) {
    const room = await this.roomService.get(payload.roomId);

    if (!room.memberIds.includes(client.userId)) {
      throw new WsException('You are not in this room!');
    }

    client.to(payload.roomId).emit(EmitEvent.ReceiveGroupMessage, {
      ...payload,
      senderId: client.userId,
    });
  }

  /**
   * Transfer ownership to another member in room.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.TranserOwnership),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.TranserOwnership)
  async handleTransferOwnership(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: TransferOwnershipDto,
  ) {
    const room = await this.roomService.transferOwnership(
      payload.roomId,
      client.userId,
      payload.candidateId,
    );

    this.server.to(room.id).emit(EmitEvent.ReceiveRoomChanges, {
      event: RoomEvent.Owner,
      actorId: client.userId,
      room: {
        id: room.id,
        ownerId: room.ownerId,
      },
    });
  }

  /**
   * Invite a guest into room.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.InviteToRoom),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.InviteToRoom)
  async handleInviteToRoom(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: InviteToRoomDto,
  ) {
    const { room, guestSIds } = await this.roomService.invite(
      payload.roomId,
      client.userId,
      payload.guestId,
    );

    this.server.to(guestSIds).emit(EmitEvent.ReceiveRoomInvitation, {
      roomId: room.id,
      inviterId: client.userId,
    });
    this.server.to(room.id).emit(EmitEvent.ReceiveRoomChanges, {
      event: RoomEvent.Invite,
      actorId: client.userId,
      room: {
        id: room.id,
        waitingIds: room.waitingIds,
      },
    });
  }

  /**
   * Reply invitation.
   *
   * @param client socket client.
   * @param payload
   */
  @UseInterceptors(
    new EventNameBindingInterceptor(ListenEvent.RespondInvitation),
    SocketUserIdBindingInterceptor,
  )
  @SubscribeMessage(ListenEvent.RespondInvitation)
  async handleRespondInvitation(
    @ConnectedSocket() client: Socket<null, EmitEvents>,
    payload: RespondInvitationDto,
  ) {
    const room = await this.roomService.respondInvitation(
      payload.roomId,
      client.userId,
      payload.isAccpeted,
    );

    if (payload.isAccpeted) {
      client.join(room.id);
    }

    this.server.to(room.id).emit(EmitEvent.ReceiveRoomChanges, {
      event: RoomEvent.Join,
      actorId: client.userId,
      room: {
        id: room.id,
        memberIds: room.memberIds,
        waitingIds: room.waitingIds,
        refusedIds: room.refusedIds,
      },
    });
  }
}
