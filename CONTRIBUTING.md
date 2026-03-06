# Contributing

We welcome contributions! Here's how to get started:

## Reporting Issues

- **Search existing issues** before creating a new one
- **Include details**: Stream Deck model, OS, plugin version, error messages
- **Attach logs** from `dev.neave.sems.solar.monitoring.sdPlugin/logs/`

## Submitting Pull Requests

1. **Fork the repository** on GitHub

2. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**:

   - Follow the existing code style
   - Add comments for complex logic
   - Test thoroughly on both Windows and macOS (if possible)

4. **Commit your changes**:

   ```bash
   git commit -m "Add: Brief description of your changes"
   ```

   Use [conventional commit](https://www.conventionalcommits.org/) prefixes: `Add:`, `Fix:`, `Update:`, `Refactor:`, `Docs:`

5. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

6. **Open a Pull Request** on GitHub with:
   - Clear description of changes
   - Related issue numbers (if applicable)
   - Screenshots/videos for UI changes

## Code Standards

- **TypeScript**: Use strict type checking
- **Formatting**: Follow existing indentation and style
- **Error Handling**: Always handle API failures gracefully
- **Comments**: Document API interactions and business logic
- **Secrets**: Never commit credentials or API keys

## Testing Checklist

Before submitting a PR, verify:

- [ ] Plugin builds without errors: `npm run build`
- [ ] Plugin loads in Stream Deck without crashes
- [ ] API authentication works with valid credentials
- [ ] Data displays correctly on Stream Deck keys
- [ ] Property Inspector shows configuration options
- [ ] Errors are handled gracefully (network issues, invalid credentials)
- [ ] No console errors or warnings
- [ ] Logs are informative but not excessive

## Development Tips

- **API Testing**: Use `secret.http` (not committed) for quick API exploration with REST Client extension
- **Debugging**: Enable Node.js debugging in manifest.json (`"Debug": "enabled"`)
- **Logs**: Check `logs/` directory for runtime errors and API responses
- **Property Inspector**: Edit `ui/` files for configuration UI changes
- **Region Handling**: Always use the region-specific API URL from login response
