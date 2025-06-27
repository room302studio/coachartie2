# Port Standardization Plan

## Current Issues
- README shows dev ports: 18239, 27461, 35892
- Docker uses prod ports: 9991, 9993, 9994  
- Inconsistent naming: EMAIL_PORT vs EMAIL_SERVICE_PORT

## Proposed Standard Ports (Sequential, High/Unique)

### Development (.env default)
- **Capabilities**: 47001
- **SMS**: 47002  
- **Email**: 47003
- **Redis**: 6379

### Production (.env.production / Docker)
- **Capabilities**: 47101
- **SMS**: 47102
- **Email**: 47103
- **Redis**: 6379

### Monitoring/Optional
- **Redis Commander**: 47104

## Environment Variable Names (Standardized)
- `CAPABILITIES_PORT` 
- `SMS_PORT`
- `EMAIL_PORT` (not EMAIL_SERVICE_PORT)
- `REDIS_PORT`

## Changes Needed
1. Update .env.production EMAIL_SERVICE_PORT → EMAIL_PORT
2. Update docker-compose.yml to use EMAIL_PORT consistently  
3. Update README development ports to 3001, 3002, 3003
4. Update README production ports to 9991, 9992, 9993
5. Update all package.json port defaults

This gives us:
- Sequential, memorable ports
- Clear dev vs prod separation
- Consistent naming
- Room for growth