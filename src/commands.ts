import { createJsonStore } from "./json-store";
import { COMMANDS_FILE } from "./constants";

export const { get: getCommands, set: setCommands } = createJsonStore(COMMANDS_FILE);
