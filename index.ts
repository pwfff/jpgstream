import { modifyJPGStream } from "./jpgstream"

addEventListener('fetch', (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request: Request) {
  const fetchedUrl = new URL(request.url)

  if (fetchedUrl.href.includes('favicon.ico')) {
    return new Response('no')
  }

  const providedUrl = fetchedUrl.searchParams.get('url')
  const url = providedUrl ? providedUrl : 'http://httpbin.org/image/jpeg'
  let response = await fetch(url)

  let { readable, writable } = new TransformStream()
  let newResponse = new Response(readable, response)
  modifyJPGStream(response.body, writable)
  return newResponse
}
