export const QTS_DEBUG = true || Boolean(typeof process === "object" && process.env.QTS_DEBUG)
export let debugLog = QTS_DEBUG ? console.log.bind(console) : () => {}
