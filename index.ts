import { modifyJPGStream } from "./jpgstream"
import { parse } from 'ipaddr.js'

addEventListener('fetch', (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request))
})

/**
 * Fetch and log a request
 * @param {Request} request
 */
async function handleRequest(request: Request) {
  let { readable, writable } = new TransformStream()
  let body: ArrayBuffer

  if (request.method == 'POST') {
    let body = await request.arrayBuffer()

    let newResponse = new Response(readable)
    
    modifyJPGStream(new Uint8Array(body), writable, [], true)

    return newResponse
  } else {
    const addr = parse(request.headers.get("cf-connecting-ip"))
    const fetchedUrl = new URL(request.url)

    if (fetchedUrl.href.includes('favicon.ico')) {
      return new Response('no')
    }

    const providedUrl = fetchedUrl.searchParams.get('url')
    const url = providedUrl ? providedUrl : 'http://httpbin.org/image/jpeg'

    let response = await fetch(url)
    let body = await response.arrayBuffer()

    let newResponse = new Response(readable, response)

    modifyJPGStream(new Uint8Array(body), writable, addr.toByteArray(), false)

    return newResponse
  }
}
