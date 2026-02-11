# Contributing to pi-msg-bridge

Thank you for your interest in contributing! 🎉

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/tintinweb/pi-msg-bridge.git
   cd pi-msg-bridge
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Test locally**
   ```bash
   # Set up your test bot token
   export PI_TELEGRAM_TOKEN="your-test-bot-token"
   
   # Option A: Install in pi
   pi install /path/to/pi-msg-bridge
   pi
   /msg-bridge connect
   
   # Option B: Load directly from source (faster for development)
   pi -e ./src/index.ts
   /msg-bridge connect
   ```

## Project Structure

```
src/
├── index.ts              # Main entry point (event handlers, commands)
├── types.ts              # TypeScript interfaces
├── auth/
│   └── challenge-auth.ts # Authentication system
├── transports/
│   ├── interface.ts      # ITransportProvider interface
│   ├── manager.ts        # Message routing
│   └── telegram.ts       # Telegram implementation
└── ui/
    └── status-widget.ts  # Status display
```

## Adding a New Transport

To add support for a new messenger (e.g., WhatsApp, Slack, Discord):

1. **Create a provider** in `src/transports/<name>.ts`
   ```typescript
   import type { ITransportProvider } from "./interface.js";
   import type { ChallengeAuth } from "../auth/challenge-auth.js";
   
   export class WhatsAppProvider implements ITransportProvider {
     readonly type = "whatsapp";
     // Implement all ITransportProvider methods
   }
   ```

2. **Register in index.ts**
   ```typescript
   if (config.whatsapp?.token) {
     const whatsappProvider = new WhatsAppProvider(config.whatsapp.token, auth);
     transportManager.addTransport(whatsappProvider);
   }
   ```

3. **Update types** if needed in `src/types.ts`

4. **Update docs** in README.md and GETTING_STARTED.md

## Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Keep functions focused and testable

## Testing

Currently, testing is manual. Automated tests welcome!

Manual testing checklist:
- [ ] Bot connects successfully
- [ ] Challenge codes appear in terminal
- [ ] Authentication works (correct code)
- [ ] Authentication fails properly (wrong code, too many attempts)
- [ ] Messages are sent and received correctly
- [ ] Group chat mention detection works
- [ ] Admin commands work
- [ ] Widget displays correct status

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** for your feature (`git checkout -b feature/amazing-feature`)
3. **Make your changes** and commit (`git commit -m 'Add amazing feature'`)
4. **Push** to your fork (`git push origin feature/amazing-feature`)
5. **Open a Pull Request** with:
   - Clear description of changes
   - Why the change is needed
   - Any breaking changes
   - Testing performed

## Commit Messages

Follow conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Adding tests
- `chore:` Maintenance tasks

Examples:
```
feat: add WhatsApp transport support
fix: handle undefined username in Telegram messages
docs: update GETTING_STARTED with group chat setup
```

## Reporting Issues

When reporting bugs, include:

- pi version
- Extension version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Error messages (if any)

## Feature Requests

Open an issue with:

- Clear use case
- Why it's valuable
- Proposed implementation (if you have ideas)

## Questions?

Open a discussion or issue. We're here to help!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
