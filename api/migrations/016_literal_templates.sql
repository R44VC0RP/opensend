UPDATE campaign_templates
SET draft = draft - 'defaults' - 'tracking',
    published = CASE WHEN published IS NULL THEN NULL ELSE published - 'defaults' - 'tracking' END;
