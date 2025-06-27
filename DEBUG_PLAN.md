# Debugging Plan: Express Server Not Binding on macOS

## Issue Summary
- Services start and log "successfully bound to port" but nothing actually listens
- `pnpm run dev` starts services but they immediately exit without error
- Problem persists after system reboot
- Was working before recent changes

## Root Causes Identified

### 1. **Turbo Configuration Issue** (MOST LIKELY)
- Turbo is treating `dev` tasks as non-persistent and exiting immediately
- Missing `persistent: true` flag in turbo.json for watch tasks

### 2. **Express Binding Issues**
- Multiple `.listen()` calls in codebase
- Binding to wrong interface (localhost vs 0.0.0.0)
- macOS-specific networking issues with /etc/hosts

### 3. **Process Management**
- tsx watch mode not configured properly
- Silent crashes without error output

## Step-by-Step Debugging Plan

### Phase 1: Quick Fixes (5 minutes)

1. **Check turbo.json configuration**
   ```bash
   cat turbo.json
   ```
   - Look for `dev` task configuration
   - Add `"persistent": true` if missing

2. **Check for duplicate listen calls**
   ```bash
   grep -r "\.listen(" packages/capabilities/src/
   ```

3. **Verify /etc/hosts**
   ```bash
   cat /etc/hosts | grep localhost
   ```
   - Should have: `127.0.0.1 localhost`
   - Remove duplicates if found

### Phase 2: Isolate the Problem (10 minutes)

4. **Test Express server directly (bypass turbo)**
   ```bash
   cd packages/capabilities
   node -r tsx/cjs src/index.ts
   ```
   - If this works, problem is with turbo config
   - If this fails, problem is with Express/Node

5. **Create minimal test server**
   ```javascript
   // test-server.js
   const express = require('express');
   const app = express();
   
   app.get('/test', (req, res) => res.send('OK'));
   
   const server = app.listen(8080, '0.0.0.0', () => {
     console.log('Test server listening on 8080');
   });
   
   server.on('error', (err) => {
     console.error('Server error:', err);
   });
   ```
   - Run with `node test-server.js`
   - Test with `curl http://localhost:8080/test`

6. **Check process persistence**
   ```bash
   # Start service and immediately check if process exists
   pnpm run dev &
   sleep 5
   ps aux | grep tsx
   ```

### Phase 3: Fix Configuration (15 minutes)

7. **Update turbo.json**
   ```json
   {
     "pipeline": {
       "dev": {
         "cache": false,
         "persistent": true,
         "dependsOn": ["^build"]
       }
     }
   }
   ```

8. **Add error handling to Express**
   - Update src/index.ts to add error event handler
   - Add process exit handlers with logging
   - Add uncaught exception handlers

9. **Fix potential port conflicts**
   - Change from dynamic port to fixed port
   - Add EADDRINUSE error handling
   - Try different port ranges

### Phase 4: Advanced Debugging (if needed)

10. **Enable verbose logging**
    ```bash
    DEBUG=* pnpm run dev
    ```

11. **Check macOS firewall**
    ```bash
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps
    ```

12. **Use dtrace to monitor system calls**
    ```bash
    sudo dtrace -n 'syscall::bind*:entry { printf("%s %d", execname, pid); }'
    ```

### Phase 5: Alternative Solutions

13. **Use nodemon instead of tsx watch**
    ```json
    "scripts": {
      "dev": "nodemon --exec tsx src/index.ts"
    }
    ```

14. **Docker approach**
    - Create Dockerfile for each service
    - Use docker-compose for orchestration
    - Bypass macOS networking issues entirely

15. **Use PM2 for process management**
    ```bash
    pm2 start src/index.ts --interpreter tsx
    ```

## Verification Steps

After each fix attempt:
1. `curl http://localhost:18239/health`
2. `lsof -i :18239`
3. Check logs for errors
4. Verify process is still running after 30 seconds

## Expected Outcome

Services should:
- Start and remain running
- Respond to HTTP requests
- Show up in `lsof` output
- Log any errors clearly

## If All Else Fails

1. Roll back to last known working commit
2. Compare git diff to identify breaking changes
3. Consider switching to Docker for consistent networking
4. File issue with turbo/tsx maintainers with minimal reproduction