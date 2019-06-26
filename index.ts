import { modifyJPGStream } from "./jpgstream"
import { parse } from 'ipaddr.js'
import index from './index.html'

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
    
    modifyJPGStream(new Uint8Array(body), writable, new Uint8Array(), true)

    return newResponse
  } else {
    const fetchedUrl = new URL(request.url)

    // short-circuit favicon
    if (fetchedUrl.href.includes('favicon.ico')) {
      return new Response('no')
    }

    if (!fetchedUrl.searchParams.has('url')) {
      return new Response(index, {headers: {'Content-Type': 'text.html', 'Cache-Control': 'no-cache'}})
    }

    const providedUrl = fetchedUrl.searchParams.get('url')
    const imageUrl = providedUrl ? providedUrl : 'http://httpbin.org/image/jpeg'

    let payload: Uint8Array;

    const providedPayload = fetchedUrl.searchParams.get('payload')
    if (providedPayload) {
      payload = new TextEncoder().encode(providedPayload)
    } else {
      const connectingIP = request.headers.get('cf-connecting-ip') || '2606:4700:ff02:8250:f479:3dab:3e4a:54c6'
      const addr = parse(connectingIP)
      payload = new Uint8Array(addr.toByteArray())
    }

    let response = await fetch(imageUrl)
    let body = await response.arrayBuffer()

    let newResponse = new Response(readable, response)

    modifyJPGStream(new Uint8Array(body), writable, payload, false)

    return newResponse
  }
}
