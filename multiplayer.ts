import { Server, Room, Client } from "colyseus";
import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

// Player information
class Player extends Schema {
    name = "Player";
    x = 0;
    y = 0;
    z = 0;
}

defineTypes(Player, {
    name: "string",
    x: "number",
    y: "number",
    z: "number"
});

// Game information
class GameState extends Schema {
    players = new MapSchema<Player>();
}

defineTypes(GameState, {
    players: { map: Player }
});

// Multiplayer room
class MultiplayerRoom extends Room<GameState> {

    maxClients = 32;

    onCreate() {
        this.setState(new GameState());

        this.onMessage("move", (client, data) => {
            const player = this.state.players.get(client.sessionId);

            if (!player) return;

            if (
                typeof data.x === "number" &&
                typeof data.y === "number" &&
                typeof data.z === "number" &&
                Number.isFinite(data.x) &&
                Number.isFinite(data.y) &&
                Number.isFinite(data.z)
            ) {
                player.x = data.x;
                player.y = data.y;
                player.z = data.z;
            }
        });

        console.log("Multiplayer room created!");
    }

    onJoin(client: Client) {
        const player = new Player();

        player.name = "Player " + this.clients.length;

        this.state.players.set(client.sessionId, player);

        console.log("Player joined:", client.sessionId);
    }

    onLeave(client: Client) {
        this.state.players.delete(client.sessionId);

        console.log("Player left:", client.sessionId);
    }
}

// Start server
const server = new Server();

server.define("world", MultiplayerRoom);

server.listen(Number(process.env.PORT) || 2567);

console.log("Multiplayer server started!");
