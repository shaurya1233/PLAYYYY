import { Room, Client } from "colyseus";
import { GameState, PlayerState } from "../state/GameState";

export class GameRoom extends Room<GameState> {

    maxClients = 32;

    onCreate() {
        this.setState(new GameState());

        console.log("Game room created!");

        this.onMessage("move", (client, data) => {
            const player = this.state.players.get(client.sessionId);

            if (!player) return;

            if (
                Number.isFinite(data.x) &&
                Number.isFinite(data.y) &&
                Number.isFinite(data.z)
            ) {
                player.x = data.x;
                player.y = data.y;
                player.z = data.z;
            }
        });
    }

    onJoin(client: Client, options: any) {
        const player = new PlayerState();

        player.name = options?.name || "Player";
        player.x = 0;
        player.y = 0;
        player.z = 0;

        this.state.players.set(client.sessionId, player);

        console.log("Player joined:", player.name);
    }

    onLeave(client: Client) {
        this.state.players.delete(client.sessionId);

        console.log("Player disconnected:", client.sessionId);
    }
}
