import { createJsonStore } from "./json-store";
import { MESSAGES_FILE } from "./constants";

export const { get: getMessages, set: setMessages } = createJsonStore(MESSAGES_FILE);
