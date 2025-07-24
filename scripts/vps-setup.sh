#!/bin/bash

# Coach Artie 2 VPS Setup Script
# Sets up a fresh Debian VPS for Coach Artie 2 deployment

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_USER="coachartie"
APP_DIR="/home/coachartie/coachartie2"
BACKUP_DIR="/home/coachartie/backups"

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root"
        exit 1
    fi
}

# Update system packages
update_system() {
    print_status "Updating system packages..."
    apt-get update
    apt-get upgrade -y
    apt-get install -y curl wget git htop unzip software-properties-common
}

# Install Docker
install_docker() {
    print_status "Installing Docker..."
    
    # Remove old versions
    apt-get remove -y docker docker-engine docker.io containerd runc || true
    
    # Install dependencies
    apt-get install -y \
        ca-certificates \
        curl \
        gnupg \
        lsb-release
    
    # Add Docker's official GPG key
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    
    # Set up repository
    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
        $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    # Install Docker Engine
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    # Start and enable Docker
    systemctl start docker
    systemctl enable docker
    
    print_status "✓ Docker installed successfully"
}

# Install Docker Compose (standalone)
install_docker_compose() {
    print_status "Installing Docker Compose..."
    
    # Download latest version
    DOCKER_COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep -Po '"tag_name": "\K.*?(?=")')
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    
    # Make executable
    chmod +x /usr/local/bin/docker-compose
    
    # Create symlink for convenience
    ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
    
    print_status "✓ Docker Compose ${DOCKER_COMPOSE_VERSION} installed"
}

# Create application user
create_app_user() {
    print_status "Creating application user: $APP_USER"
    
    # Create user if it doesn't exist
    if ! id "$APP_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$APP_USER"
        print_status "✓ User $APP_USER created"
    else
        print_status "✓ User $APP_USER already exists"
    fi
    
    # Add user to docker group
    usermod -aG docker "$APP_USER"
    
    # Create directories
    sudo -u "$APP_USER" mkdir -p "$APP_DIR" "$BACKUP_DIR"
    
    print_status "✓ Application directories created"
}

# Setup SSH key authentication (optional)
setup_ssh_keys() {
    print_status "Setting up SSH key authentication..."
    
    # Create .ssh directory for app user
    sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
    sudo -u "$APP_USER" chmod 700 "/home/$APP_USER/.ssh"
    
    # Copy root's authorized_keys if they exist
    if [[ -f "/root/.ssh/authorized_keys" ]]; then
        cp "/root/.ssh/authorized_keys" "/home/$APP_USER/.ssh/"
        chown "$APP_USER:$APP_USER" "/home/$APP_USER/.ssh/authorized_keys"
        chmod 600 "/home/$APP_USER/.ssh/authorized_keys"
        print_status "✓ SSH keys copied to $APP_USER"
    else
        print_warning "No SSH keys found in /root/.ssh/authorized_keys"
        print_warning "You may want to add SSH keys manually later"
    fi
}

# Configure firewall
configure_firewall() {
    print_status "Configuring firewall..."
    
    # Install ufw if not present
    apt-get install -y ufw
    
    # Default policies
    ufw default deny incoming
    ufw default allow outgoing
    
    # Allow SSH
    ufw allow ssh
    
    # Allow HTTP and HTTPS
    ufw allow 80
    ufw allow 443
    
    # Allow Coach Artie port
    ufw allow 18239
    
    # Enable firewall
    ufw --force enable
    
    print_status "✓ Firewall configured"
}

# Install monitoring tools
install_monitoring() {
    print_status "Installing monitoring tools..."
    
    # Install htop, iotop, etc.
    apt-get install -y htop iotop nethogs ncdu
    
    # Install Docker system prune cron job
    cat > /etc/cron.daily/docker-cleanup << 'EOF'
#!/bin/bash
# Clean up Docker resources daily
docker system prune -af --volumes
docker image prune -af
EOF
    chmod +x /etc/cron.daily/docker-cleanup
    
    print_status "✓ Monitoring tools installed"
}

# Setup log rotation
setup_logging() {
    print_status "Setting up log rotation..."
    
    # Docker logs rotation
    cat > /etc/logrotate.d/docker << 'EOF'
/var/lib/docker/containers/*/*.log {
    daily
    rotate 7
    compress
    size 50M
    missingok
    notifempty
    sharedscripts
    copytruncate
}
EOF
    
    print_status "✓ Log rotation configured"
}

# Create systemd service for Coach Artie
create_systemd_service() {
    print_status "Creating systemd service..."
    
    cat > /etc/systemd/system/coachartie.service << EOF
[Unit]
Description=Coach Artie 2
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/docker-compose -f docker-compose.prod.yml up -d
ExecStop=/usr/local/bin/docker-compose -f docker-compose.prod.yml down
User=$APP_USER
Group=$APP_USER

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    systemctl daemon-reload
    
    print_status "✓ Systemd service created (not enabled yet)"
}

# Final system optimization
optimize_system() {
    print_status "Optimizing system..."
    
    # Increase file descriptors limit
    echo "* soft nofile 65536" >> /etc/security/limits.conf
    echo "* hard nofile 65536" >> /etc/security/limits.conf
    
    # Optimize Docker daemon
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json << 'EOF'
{
    "log-driver": "json-file",
    "log-opts": {
        "max-size": "10m",
        "max-file": "3"
    },
    "live-restore": true
}
EOF
    systemctl restart docker
    
    print_status "✓ System optimized"
}

# Show final instructions
show_final_instructions() {
    print_status "VPS setup completed successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Set up your environment variables in a .env file"
    echo "2. Deploy your application using: ./scripts/deploy.sh remote"
    echo "3. Enable the systemd service: systemctl enable coachartie"
    echo ""
    echo "Useful commands:"
    echo "  sudo systemctl start coachartie    # Start the service"
    echo "  sudo systemctl stop coachartie     # Stop the service"
    echo "  sudo systemctl status coachartie   # Check service status"
    echo "  docker-compose -f docker-compose.prod.yml logs -f  # View logs"
    echo ""
    echo "Application will be available at: http://your-server-ip:18239"
}

# Main setup function
main() {
    print_status "Starting Coach Artie 2 VPS setup..."
    
    check_root
    update_system
    install_docker
    install_docker_compose
    create_app_user
    setup_ssh_keys
    configure_firewall
    install_monitoring
    setup_logging
    create_systemd_service
    optimize_system
    show_final_instructions
}

# Run main function
main "$@"