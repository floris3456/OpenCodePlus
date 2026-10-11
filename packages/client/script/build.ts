import { fileURLToPath } from "node:url"
import { generate } from "./generate"

await generate(fileURLToPath(new URL("..", import.meta.url)))
