import { createJsonStore } from "./json-store.js";
import { COMMANDS_FILE } from "./constants.js";

export const { get: getCommands, set: setCommands } = createJsonStore(COMMANDS_FILE);
