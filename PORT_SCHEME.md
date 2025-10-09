# Coach Artie Port Scheme

## Simplified Port Configuration
All services use the **same port internally and externally** for consistency and easier debugging.

### Port Assignments (47320-47326 range)

| Service       | Port  | Purpose                    | Access                  |
|--------------|-------|----------------------------|-------------------------|
| Redis        | 47320 | Job Queue & Cache          | localhost:47320         |
| Discord      | 47321 | Discord Bot Health         | localhost:47321/health  |
| Capabilities | 47324 | AI Processing Engine       | localhost:47324         |
| Brain        | 47325 | Dashboard UI               | localhost:47325         |
| SMS          | 47326 | SMS Service                | localhost:47326         |

### Internal Docker Network Communication

Services communicate using hostnames within Docker:
- `http://capabilities:47324/chat` - Job submission
- `redis:47320` - Redis connection
- `http://brain:47325/api` - Dashboard API

### Benefits of This Scheme

1. **No Port Mapping Confusion**: External port = Internal port
2. **Sequential Range**: Easy to remember (47320-47326)
3. **No Conflicts**: High port range unlikely to conflict
4. **Consistent Access**: Every service accessible the same way
5. **Easier Debugging**: Direct access to all services from host

### Quick Test Commands

```bash
# Check Redis
redis-cli -p 47320 ping

# Check Capabilities
curl http://localhost:47324/health

# Check Brain Dashboard
curl http://localhost:47325/api/status

# Check SMS Service
curl http://localhost:47326/health

# Check Discord Health
curl http://localhost:47321/health
```

### Environment Variables

All services know their ports via environment variables:
- `REDIS_PORT=47320`
- `DISCORD_PORT=47321`
- `CAPABILITIES_PORT=47324`
- `BRAIN_PORT=47325`
- `SMS_PORT=47326`