import { createJsonStore } from "./json-store.js";
import { MESSAGES_FILE } from "./constants.js";

export const { get: getMessages, set: setMessages } = createJsonStore(MESSAGES_FILE);
