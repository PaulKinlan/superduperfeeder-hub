# Super Duper Feeder

A Spec compliant WebSub/PubSubHubbub service that allows users to subscribe to RSS feeds and get notified when new content is available.

## Features

- WebSub/PubSubHubbub hub functionality
- RSS feed polling for feeds that don't support WebSub
- Real-time updates via WebSockets, Server-Sent Events (SSE), and webhooks
- Admin interface for system management
- Simple, clean UI with documentation

## Technology Stack

- Runtime: Deno
- Hosting: Deno Deploy
- Database: DenoKV
- Queue: Deno Deploy's built-in queue system

## Getting Started

### Local Development

```bash
# Start the server locally
deno task dev
```

The server will be available at http://localhost:8000.

### Testing

The project includes a comprehensive test harness for unit and integration testing:

```bash
# Run all tests
deno task test
```

See the [tests/README.md](tests/README.md) file for more details on the test harness.

### Documentation

The documentation is available at http://localhost:8000/docs when running locally.

### Endpoints

- `/` - WebSub hub endpoint
- `/docs` - Documentation
- `/health` - Health check endpoint
- `/firehose/ws` - WebSocket endpoint for real-time updates
- `/firehose/sse` - Server-Sent Events endpoint for real-time updates
- `/firehose/webhook` - Webhook configuration endpoint

### Deployment

The service is deployed to Deno Deploy at: [superduperfeeder.deno.dev](https://superduperfeeder.deno.dev)

## Project Structure

```
/
├── main.ts                 # Entry point
├── config.ts               # Configuration
├── deps.ts                 # Dependencies
├── routes/                 # API routes
│   ├── index.ts            # Main router
│   ├── hub.ts              # WebSub hub endpoints
│   ├── firehose.ts         # Firehose endpoints
│   └── static.ts           # Static file serving
├── services/               # Business logic
│   ├── hub.ts              # WebSub hub service
│   ├── polling.ts          # RSS polling service
│   └── firehose.ts         # Firehose service
├── models/                 # Data models
│   ├── subscription.ts     # Subscription model
│   ├── feed.ts             # Feed model
│   ├── webhook.ts          # Webhook model
│   └── user.ts             # User model
├── utils/                  # Utilities
│   └── database.ts         # Database connection
├── tests/                  # Test harness
│   ├── unit/               # Unit tests
│   ├── integration/        # Integration tests
│   ├── mocks/              # Mock implementations
│   ├── utils/              # Test utilities
│   ├── run_tests.ts        # Test runner
│   └── README.md           # Test documentation
└── ui/                     # UI assets
    └── public/             # Public UI assets
        ├── index.html      # Documentation page
        └── styles.css      # CSS styles
```

## API Documentation

See the [documentation](https://superduperfeeder.deno.dev/docs) for detailed API usage.

## License

See the [LICENSE](LICENSE) file for details.
