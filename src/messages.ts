import { createJsonStore } from "./json-store.js";

export const { get: getMessages, set: setMessages } = createJsonStore("messages.json");
