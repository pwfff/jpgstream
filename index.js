import { modifyJPGStream } from "./jpgstream.js"

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request) {
  const providedUrl = new URL(request.url).searchParams.get('url')
  const url = providedUrl ? providedUrl : 'http://httpbin.org/image/jpeg'
  let response = await fetch(url)

  let { readable, writable } = new TransformStream()
  let newResponse = new Response(readable, response)
  modifyJPGStream(response.body, writable)
  return newResponse
}
