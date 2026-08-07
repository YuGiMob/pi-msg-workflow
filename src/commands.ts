import { createJsonStore } from "./json-store.js";

export const { get: getCommands, set: setCommands } = createJsonStore("commands.json");
