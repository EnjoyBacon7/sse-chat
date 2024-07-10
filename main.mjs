import http from 'http'
import fs from 'fs'
import readStream from './readStream.mjs'
import Queue from './Queue.mjs'

class Message {
  constructor(text) {
    this.id = lastid++
    this.time = new Date().toISOString()
    this.text = text.replace(/\s+/g, ' ')
    this.buffer = Buffer.from(`id:${this.id}\ndata:${JSON.stringify({
      time: this.time,
      text: this.text
    })}\n\n`)
  }
}

const esHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
}
let lastid = 1

const clients = new Set() // this is where we store the open response streams
const messages = new Queue()
const chatHistoryFile = '/data/messages.txt'

// Function to load chat history from file
function loadChatHistory(filePath) {
  if (!fs.existsSync(filePath)) return
  const data = fs.readFileSync(filePath, 'utf8')
  const lines = data.split('\n').filter(line => line.trim())
  for (const line of lines) {
    const { time, text } = JSON.parse(line)
    const message = new Message(text)
    message.time = time // Restore the original time
    message.buffer = Buffer.from(`id:${message.id}\ndata:${JSON.stringify({
      time: message.time,
      text: message.text
    })}\n\n`)
    messages.push(message)
    if (messages.length > 1000) messages.shift()
  }
}

// Function to append a message to the chat history file
function appendToChatHistory(filePath, message) {
  const logEntry = JSON.stringify({ time: message.time, text: message.text })
  fs.appendFileSync(filePath, logEntry + '\n', 'utf8')
}

// Load chat history on startup
loadChatHistory(chatHistoryFile)

const server = http.createServer((req, res) => {
  if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin)

  // GET /         ->      start an event-stream response
  if (req.url === '/') {
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Methods', 'GET')
    if (clients.size > 1000) {
      res.writeHead(503)
      res.end('Il y a trop de monde sur le canal ; revenez plus tard.')
      return
    }
    switch (req.method) {
      case 'OPTIONS': break
      case 'GET':
      res.writeHead(200, esHeaders)
      clients.add(res)
      const lastEventId = req.headers['Last-Event-ID']
      for (const message of messages.valuesAfterID(lastEventId)) res.write(message.buffer)
      req.socket.addListener('close', () => {
        clients.delete(res)
      })
      return
      default: res.writeHead(405)
    }
  }
  // POST /send     ->     add a message
  else if (req.url === '/send') {
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Methods', 'POST')
    switch (req.method) {
      case 'OPTIONS': break
      case 'POST':
      readStream(req, 4095)
      .then(buffer => {
        const messageText = buffer.toString()
        const message = new Message(messageText)
        messages.push(message)
        if (messages.length > 1000) messages.shift()
        appendToChatHistory(chatHistoryFile, message)
        for (const client of clients) client.write(message.buffer)
        res.writeHead(204)
        res.end()
      })
      .catch(err => {
        res.writeHead(400)
        res.end(err.message)
      })
      return
      default: res.writeHead(405)
    }
  } else res.writeHead(404)
  res.end()
})

server.listen(8916)

// ping to keep connections alive when channel is inactive
const ping = Buffer.from(':ping\n\n')
function keepalive() {
  for (const client of clients) client.write(ping)
  keepaliveTimer = setTimeout(keepalive, 3e4)
}
let keepaliveTimer = setTimeout(keepalive, 3e4)
