import CloudFoundryClient from '../../lib/cf';
import {
  IApplication,
  IOrganizationUserRoles,
  IRoute,
  IServiceInstance,
  ISpace,
} from '../../lib/cf/types';
import { IParameters, IResponse } from '../../lib/router';

import { IContext } from '../app/context';
import { CLOUD_CONTROLLER_ADMIN, CLOUD_CONTROLLER_GLOBAL_AUDITOR, CLOUD_CONTROLLER_READ_ONLY_ADMIN } from '../auth';

import spaceApplicationsTemplate from './applications.njk';
import spaceBackingServicesTemplate from './backing-services.njk';
import spacesTemplate from './spaces.njk';

function buildURL(route: IRoute): string {
  return [route.host, route.domain.name].filter(x => x).join('.') + route.path;
}

export async function listApplications(ctx: IContext, params: IParameters): Promise<IResponse> {
  const cf = new CloudFoundryClient({
    accessToken: ctx.token.accessToken,
    apiEndpoint: ctx.app.cloudFoundryAPI,
    logger: ctx.app.logger,
  });

  const isAdmin = ctx.token.hasAnyScope(
    CLOUD_CONTROLLER_ADMIN,
    CLOUD_CONTROLLER_READ_ONLY_ADMIN,
    CLOUD_CONTROLLER_GLOBAL_AUDITOR,
  );

  const [isManager, isBillingManager, space, applications, organization, cflinuxfs2StackGUID] = await Promise.all([
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'org_manager'),
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'billing_manager'),
    cf.space(params.spaceGUID),
    cf.applications(params.spaceGUID),
    cf.organization(params.organizationGUID),
    cf.cflinuxfs2StackGUID(),
  ]);

  const summarisedApplications = await Promise.all(applications.map(async (application: IApplication) => {
    const summary = await cf.applicationSummary(application.metadata.guid);

    return {
      metadata: application.metadata,
      entity: {
        ...application.entity,
        ...summary,

        urls: summary.routes.map(buildURL),
      },
    };
  }));

  /* istanbul ignore next */
  // tslint:disable:max-line-length
  const cflinuxfs2UpgradeNeeded = cflinuxfs2StackGUID && summarisedApplications.filter((app: IApplication) => app.entity.stack_guid === cflinuxfs2StackGUID).length > 0;
  return {
    body: spaceApplicationsTemplate.render({
      routePartOf: ctx.routePartOf,
      linkTo: ctx.linkTo,
      csrf: ctx.csrf,
      applications: summarisedApplications,
      cflinuxfs2UpgradeNeeded,
      organization,
      space,
      cflinuxfs2StackGUID,
      isAdmin,
      isBillingManager,
      isManager,
      location: ctx.app.location,
    }),
  };
}

export async function listBackingServices(ctx: IContext, params: IParameters): Promise<IResponse> {
  const cf = new CloudFoundryClient({
    accessToken: ctx.token.accessToken,
    apiEndpoint: ctx.app.cloudFoundryAPI,
    logger: ctx.app.logger,
  });

  const isAdmin = ctx.token.hasAnyScope(
    CLOUD_CONTROLLER_ADMIN,
    CLOUD_CONTROLLER_READ_ONLY_ADMIN,
    CLOUD_CONTROLLER_GLOBAL_AUDITOR,
  );

  const [isManager, isBillingManager, space, services, userServices, organization] = await Promise.all([
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'org_manager'),
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'billing_manager'),
    cf.space(params.spaceGUID),
    cf.services(params.spaceGUID),
    cf.userServices(params.spaceGUID),
    cf.organization(params.organizationGUID),
  ]);

  const summarisedServices = await Promise.all(services.map(async (service: IServiceInstance) => {
    const [plan, serviceDefinition] = await Promise.all([
      cf.servicePlan(service.entity.service_plan_guid),
      cf.service(service.entity.service_guid),
    ]);

    return {
      definition: serviceDefinition,
      entity: service.entity,
      metadata: service.metadata,
      plan,
    };
  }));

  return {
    body: spaceBackingServicesTemplate.render({
      routePartOf: ctx.routePartOf,
      linkTo: ctx.linkTo,
      csrf: ctx.csrf,
      services: [...summarisedServices, ...userServices],
      organization,
      space,
      isAdmin,
      isBillingManager,
      isManager,
      location: ctx.app.location,
    }),
  };
}

export async function listSpaces(ctx: IContext, params: IParameters): Promise<IResponse> {
  const cf = new CloudFoundryClient({
    accessToken: ctx.token.accessToken,
    apiEndpoint: ctx.app.cloudFoundryAPI,
    logger: ctx.app.logger,
  });

  const isAdmin = ctx.token.hasAnyScope(
    CLOUD_CONTROLLER_ADMIN,
    CLOUD_CONTROLLER_READ_ONLY_ADMIN,
    CLOUD_CONTROLLER_GLOBAL_AUDITOR,
  );

  const [isManager, isBillingManager, spaces, organization, users, cflinuxfs2StackGUID] = await Promise.all([
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'org_manager'),
    cf.hasOrganizationRole(params.organizationGUID, ctx.token.userID, 'billing_manager'),
    cf.spaces(params.organizationGUID),
    cf.organization(params.organizationGUID),
    cf.usersForOrganization(params.organizationGUID),
    cf.cflinuxfs2StackGUID(),
  ]);

  const managers = users.filter((user: IOrganizationUserRoles) =>
    user.entity.organization_roles.some(role => role === 'org_manager'),
  );

  const summarisedSpaces = await Promise.all(spaces.map(async (space: ISpace) => {
    const [applications, quota] = await Promise.all([
      cf.applications(space.metadata.guid),
      space.entity.space_quota_definition_guid ?
          cf.spaceQuota(space.entity.space_quota_definition_guid) : Promise.resolve(null),
    ]);

    /* istanbul ignore next */
    // tslint:disable:max-line-length
    const cflinuxfs2UpgradeNeededInSpace = cflinuxfs2StackGUID && applications.some((app: IApplication) => app.entity.stack_guid === cflinuxfs2StackGUID);
    return {
      entity: {
        ...space.entity,
        apps: applications,
        running_apps: applications.filter((app: IApplication) => app.entity.state.toLowerCase() !== 'stopped'),
        stopped_apps: applications.filter((app: IApplication) => app.entity.state.toLowerCase() === 'stopped'),
        cflinuxfs2UpgradeNeeded: cflinuxfs2UpgradeNeededInSpace,
        memory_allocated: applications.reduce((allocated: number, app: IApplication) =>
          allocated + (app.entity.memory * app.entity.instances), 0),
        quota,
      },
      metadata: space.metadata,
    };
  }));

  const summerisedOrganization = {
    entity: {
      ...organization.entity,

      quota: await cf.organizationQuota(organization.entity.quota_definition_guid),
      memory_allocated: summarisedSpaces
        .reduce((allocated: number, space: {entity: {memory_allocated: number}}) => {
          return allocated + space.entity.memory_allocated;
        }, 0),
    },
    metadata: organization.metadata,
  };

  const cflinuxfs2UpgradeNeeded = summarisedSpaces.some((s: any) => s.entity.cflinuxfs2UpgradeNeeded);

  return {
    body: spacesTemplate.render({
      routePartOf: ctx.routePartOf,
      linkTo: ctx.linkTo,
      csrf: ctx.csrf,
      managers,
      organization: summerisedOrganization,
      spaces: summarisedSpaces,
      users,
      isAdmin,
      isBillingManager,
      isManager,
      location: ctx.app.location,
      cflinuxfs2UpgradeNeeded,
    }),
  };
}
