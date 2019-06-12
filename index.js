import { modifyJPGStream } from "./jpgstream.js"

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request) {
  let response = await fetch('http://httpbin.org/image/jpeg')

  let { readable, writable } = new TransformStream()
  let newResponse = new Response(readable, { status: 200 })
  modifyJPGStream(response.body, writable)
  return newResponse
  // return new Response(readable, response)
}
