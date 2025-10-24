# Coach Artie 2 - Scripts

## Database Backup

Automated hourly backup system for the SQLite database.

### Automatic Backups

A LaunchAgent runs every hour to back up the database:

```bash
# Check backup status
launchctl list | grep coachartie

# View backup logs
tail -f ~/code/coachartie2/logs/backup.log

# List backups
ls -lht ~/code/coachartie2/backups/
```

### Manual Backup

```bash
# Run backup immediately
./scripts/backup-database.sh
```

### Configuration

- **Location**: `~/code/coachartie2/backups/`
- **Frequency**: Every hour
- **Retention**: Last 48 backups (2 days)
- **LaunchAgent**: `~/Library/LaunchAgents/com.coachartie.backup.plist`

### Uninstall Automatic Backups

```bash
launchctl unload ~/Library/LaunchAgents/com.coachartie.backup.plist
rm ~/Library/LaunchAgents/com.coachartie.backup.plist
```

## Networking Doctor

A comprehensive network diagnostic script for debugging phantom server issues on macOS.

### Usage

```bash
# Basic usage (tests default port 18239)
./scripts/networking_doctor.sh

# Test specific port
./scripts/networking_doctor.sh 3000

# Test specific port and host
./scripts/networking_doctor.sh 3000 127.0.0.1
```

### What it checks

1. **Basic System Info** - macOS version, Node.js, Python
2. **Firewall Status** - macOS firewall configuration
3. **Network Security Software** - Little Snitch, antivirus, VPN
4. **System Security Settings** - SIP, Gatekeeper, Node.js permissions
5. **Network Interface Configuration** - Loopback interface status
6. **Localhost Resolution** - IPv6/IPv4 resolution issues
7. **Port Availability** - Check if ports are in use
8. **Socket Binding Tests** - Python and Node.js binding tests
9. **Process Analysis** - Zombie tsx/node processes
10. **System Logs** - Security denials in recent logs
11. **Recommendations** - Specific fixes for common issues
12. **Summary** - Quick diagnostic overview

### Common Issues Detected

- **IPv6/IPv4 Localhost Conflict**: Detects `::1 localhost` entries that cause phantom server issues
- **Port Conflicts**: Identifies processes using target ports
- **Zombie Processes**: Finds leftover tsx/node processes
- **Security Software**: Detects network monitoring tools that might block connections
- **Firewall Restrictions**: Identifies firewall rules blocking Node.js

### Example Output

```
🔍 Coach Artie 2 - Network Diagnostics
Testing port: 18239, host: 127.0.0.1
==============================================

📋 1. BASIC SYSTEM INFO
macOS Version: 15.5
Architecture: arm64
Node.js: v20.16.0
Python: Python 3.13.5

🔥 2. FIREWALL STATUS
✅ Firewall accessible
Mode: Limit incoming connections to specific services and applications

...

💡 11. RECOMMENDATIONS
❌ IPv6 localhost entry found in /etc/hosts
   Recommendation: Comment out '::1 localhost' line
   Command: sudo sed -i '' 's/::1.*localhost/# &/' /etc/hosts

📊 DIAGNOSTIC SUMMARY
Port Available: YES
Socket Binding: SUCCESS
System Ready: YES
```

### Integration with Development Workflow

Add to `package.json` scripts:

```json
{
  "scripts": {
    "diagnose": "./scripts/networking_doctor.sh",
    "diagnose:port": "./scripts/networking_doctor.sh"
  }
}
```

Use before starting services:

```bash
# Check system health
pnpm diagnose

# Clean start services
pnpm run dev:clean
```
