import React, { useState, useEffect } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  Box,
  CssBaseline,
  Drawer,
  AppBar,
  Toolbar,
  List,
  Typography,
  Divider,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  CircularProgress,
  Alert,
  useTheme
} from '@mui/material';

// Icons
import ViewListIcon from '@mui/icons-material/ViewList';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import StorageIcon from '@mui/icons-material/Storage';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import SettingsIcon from '@mui/icons-material/Settings';
import DashboardIcon from '@mui/icons-material/Dashboard';

// Import pages
import Dashboard from './pages/Dashboard';
import Containers from './pages/docker/Containers';
import Images from './pages/docker/Images';
import Volumes from './pages/docker/Volumes';
import Networks from './pages/docker/Networks';
import Environments from './pages/settings/Environments';

// Note: This line relies on Docker Desktop's presence as a host application.
const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

// Environment interface
export interface Environment {
  id: string;
  name: string;
  hostname: string;
  username: string;
}

// Settings interface
export interface ExtensionSettings {
  environments: Environment[];
  activeEnvironmentId?: string;
  autoConnect?: boolean;
}

// Create a type for pages
type PageKey =
  | 'dashboard'
  | 'containers'
  | 'images'
  | 'volumes'
  | 'networks'
  | 'environments';

interface NavItem {
  key: PageKey;
  label: string;
  icon: React.ReactNode;
  category: 'docker' | 'settings';
}

const drawerWidth = 240;

export function App() {
  const theme = useTheme();
  const ddClient = useDockerDesktopClient();
  const [currentPage, setCurrentPage] = useState<PageKey>('dashboard');
  const [settings, setSettings] = useState<ExtensionSettings>({
    environments: []
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Navigation items
  const navItems: NavItem[] = [
    { key: 'dashboard', label: 'Dashboard', icon: <DashboardIcon />, category: 'docker' },
    { key: 'containers', label: 'Containers', icon: <ViewListIcon />, category: 'docker' },
    { key: 'images', label: 'Images', icon: <PhotoLibraryIcon />, category: 'docker' },
    { key: 'volumes', label: 'Volumes', icon: <StorageIcon />, category: 'docker' },
    { key: 'networks', label: 'Networks', icon: <NetworkCheckIcon />, category: 'docker' },
    { key: 'environments', label: 'Environments', icon: <SettingsIcon />, category: 'settings' }
  ];

  // Load settings on component mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Load settings from extension storage
  const loadSettings = async () => {
    setIsLoading(true);
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.get('/settings');

      // Parse response if it's a string
      let parsedSettings: ExtensionSettings;
      if (typeof response === 'string') {
        parsedSettings = JSON.parse(response);
      } else {
        parsedSettings = response as ExtensionSettings;
      }

      setSettings(parsedSettings);
      console.log('Settings loaded:', parsedSettings);
    } catch (err: any) {
      console.error('Failed to load settings:', err);
      setError('Failed to load settings: ' + (err.message || 'Unknown error'));
      // Initialize with empty settings if loading fails
      setSettings({
        environments: []
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Save settings to extension storage
  const saveSettings = async (newSettings: ExtensionSettings): Promise<boolean> => {
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const stringifiedSettings = JSON.stringify(newSettings);
      const response = await ddClient.extension.vm.service.post('/settings', stringifiedSettings);

      // Check if the response indicates success
      const success = response && typeof response === 'object' && 'success' in response;

      if (success) {
        setSettings(newSettings);
        console.log('Settings saved successfully:', newSettings);
        return true;
      } else {
        console.error('Failed to save settings, unexpected response:', response);
        return false;
      }
    } catch (err: any) {
      console.error('Failed to save settings:', err);
      setError('Failed to save settings: ' + (err.message || 'Unknown error'));
      return false;
    }
  };

  // Get active environment
  const getActiveEnvironment = (): Environment | undefined => {
    if (!settings.activeEnvironmentId) return undefined;
    return settings.environments.find(env => env.id === settings.activeEnvironmentId);
  };

  // Set active environment
  const setActiveEnvironment = async (environmentId: string | undefined) => {
    const newSettings = {
      ...settings,
      activeEnvironmentId: environmentId
    };
    await saveSettings(newSettings);
  };

  // Handle environment change
  const handleEnvironmentChange = (event: SelectChangeEvent<string>) => {
    const envId = event.target.value;
    setActiveEnvironment(envId === "none" ? undefined : envId);
  };

  // Render current page
  const renderPage = () => {
    const activeEnvironment = getActiveEnvironment();

    switch (currentPage) {
      case 'dashboard':
        return (
          <Dashboard
            activeEnvironment={activeEnvironment}
            settings={settings}
            onSetActiveEnvironment={setActiveEnvironment}
          />
        );
      case 'containers':
        return (
          <Containers
            activeEnvironment={activeEnvironment}
            settings={settings}
          />
        );
      case 'images':
        return (
          <Images
            activeEnvironment={activeEnvironment}
            settings={settings}
          />
        );
      case 'volumes':
        return (
          <Volumes
            activeEnvironment={activeEnvironment}
            settings={settings}
          />
        );
      case 'networks':
        return (
          <Networks
            activeEnvironment={activeEnvironment}
            settings={settings}
          />
        );
      case 'environments':
        return (
          <Environments
            settings={settings}
            onSaveSettings={saveSettings}
            onSetActiveEnvironment={setActiveEnvironment}
          />
        );
      default:
        return <Typography>Page not found</Typography>;
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex' }}>
      <CssBaseline />

      {/* App bar */}
      <AppBar
        position="fixed"
        sx={{
          width: `calc(100% - ${drawerWidth}px)`,
          ml: `${drawerWidth}px`,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: `1px solid ${theme.palette.divider}`
        }}
        elevation={0}
      >
        <Toolbar>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            {navItems.find(item => item.key === currentPage)?.label || 'Remote Docker'}
          </Typography>

          {/* Environment selector dropdown (only show for docker resource pages) */}
          {currentPage !== 'environments' && settings.environments.length > 0 && (
            <FormControl sx={{ minWidth: 200 }} size="small">
              <InputLabel id="environment-select-label">Environment</InputLabel>
              <Select
                labelId="environment-select-label"
                id="environment-select"
                value={settings.activeEnvironmentId || "none"}
                label="Environment"
                onChange={handleEnvironmentChange}
              >
                <MenuItem value="none">-- Select Environment --</MenuItem>
                {settings.environments.map((env) => (
                  <MenuItem key={env.id} value={env.id}>{env.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
        </Toolbar>
      </AppBar>

      {/* Sidebar navigation */}
      <Drawer
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: drawerWidth,
            boxSizing: 'border-box',
          },
        }}
        variant="permanent"
        anchor="left"
      >
        <Toolbar>
          <Typography variant="h6" noWrap component="div">
            Remote Docker
          </Typography>
        </Toolbar>
        <Divider />

        {/* Docker resources section */}
        <List>
          {navItems.filter(item => item.category === 'docker').map((item) => (
            <ListItem key={item.key} disablePadding>
              <ListItemButton
                selected={currentPage === item.key}
                onClick={() => setCurrentPage(item.key)}
              >
                <ListItemIcon>
                  {item.icon}
                </ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        <Divider />

        {/* Settings section */}
        <List>
          {navItems.filter(item => item.category === 'settings').map((item) => (
            <ListItem key={item.key} disablePadding>
              <ListItemButton
                selected={currentPage === item.key}
                onClick={() => setCurrentPage(item.key)}
              >
                <ListItemIcon>
                  {item.icon}
                </ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>

      {/* Main content */}
      <Box
        component="main"
        sx={{ flexGrow: 1, bgcolor: 'background.default', p: 3, marginTop: 8 }}
      >
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Render the current page */}
        {renderPage()}
      </Box>
    </Box>
  );
}