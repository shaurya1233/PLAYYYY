import { Schema, defineTypes } from "@colyseus/schema";

export class PlayerState extends Schema {

    name = "Player";

    x = 0;
    y = 0;
    z = 0;

    rotation = 0;

    vehicle = "on-foot";

    isMoving = false;
}

defineTypes(PlayerState, {
    name: "string",

    x: "number",
    y: "number",
    z: "number",

    rotation: "number",

    vehicle: "string",

    isMoving: "boolean"
});
