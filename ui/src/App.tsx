import React, { useState, useEffect } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  AppBar,
  Box,
  Tab,
  Tabs,
  Toolbar,
  Typography,
  useTheme
} from '@mui/material';

// Import the pages
import Dashboard from './pages/Dashboard';
import Environments from './pages/Environments';

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

// Tab panel component for navigation
interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`nav-tabpanel-${index}`}
      aria-labelledby={`nav-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Box sx={{ p: 3 }}>
          {children}
        </Box>
      )}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `nav-tab-${index}`,
    'aria-controls': `nav-tabpanel-${index}`,
  };
}

export function App() {
  const theme = useTheme();
  const ddClient = useDockerDesktopClient();
  const [tabValue, setTabValue] = useState(0);
  const [settings, setSettings] = useState<ExtensionSettings>({
    environments: []
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Load settings on component mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Handle tab change
  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  // Load settings from extension storage
  const loadSettings = async () => {
    setIsLoading(true);
    try {
      // Make sure all required properties exist
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

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Typography>Loading...</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Remote Docker Connector
          </Typography>
        </Toolbar>
        <Tabs
          value={tabValue}
          onChange={handleTabChange}
          indicatorColor="primary"
          textColor="primary"
          variant="fullWidth"
          aria-label="navigation tabs"
        >
          <Tab label="Dashboard" {...a11yProps(0)} />
          <Tab label="Environments" {...a11yProps(1)} />
        </Tabs>
      </AppBar>

      {error && (
        <Box sx={{ p: 2, bgcolor: 'error.light', color: 'error.contrastText' }}>
          <Typography>{error}</Typography>
        </Box>
      )}

      <TabPanel value={tabValue} index={0}>
        <Dashboard
          activeEnvironment={getActiveEnvironment()}
          settings={settings}
          onSetActiveEnvironment={setActiveEnvironment}
        />
      </TabPanel>
      <TabPanel value={tabValue} index={1}>
        <Environments
          settings={settings}
          onSaveSettings={saveSettings}
          onSetActiveEnvironment={setActiveEnvironment}
        />
      </TabPanel>
    </Box>
  );
}