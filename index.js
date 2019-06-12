import { JPGTransformStream } from "./jpgstream.js"

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request) {
  return fetch('http://httpbin.org/image/jpeg').then(
    r => r.body
  ).then(
    b => b.pipeThrough(new JPGTransformStream())
  ).then(
    rs => new Response(rs, { status: 200 })
  )
}
