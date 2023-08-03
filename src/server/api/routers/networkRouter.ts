import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { IPv4gen } from "~/utils/IPv4gen";
import {
  type Config,
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";
import * as ztController from "~/utils/ztApi";
import { handleAutoAssignIP, updateNetworkMembers } from "../networkService";
import { Address4, Address6 } from "ip-address";
import {
  type NetworkAndMembers,
  type MembersEntity,
  type ZtControllerNetwork,
  type IpAssignmentPoolsEntity,
  type Peers,
  type NetworkEntity,
  type Paths,
  type CapabilitiesByName,
  type TagsByName,
} from "~/types/network";
import RuleCompiler from "~/utils/rule-compiler";
import { throwError, type APIError } from "~/server/helpers/errorHandler";
import { type networkMembers } from "@prisma/client";
import { createTransporter, inviteUserTemplate, sendEmail } from "~/utils/mail";
import * as centralApi from "~/utils/ztCentralApi";
import ejs from "ejs";

const customConfig: Config = {
  dictionaries: [adjectives, animals],
  separator: "-",
  length: 2,
};

function isValidIP(ip: string): boolean {
  return Address4.isValid(ip) || Address6.isValid(ip);
}
function isValidDomain(domain: string): boolean {
  const domainRegex =
    /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}
const RouteSchema = z.object({
  target: z
    .string()
    .optional()
    .refine((val) => val !== undefined && isValidCIDR(val), {
      message: "Destination IP must be a valid CIDR notation!",
    }),
  via: z
    .union([
      z
        .string()
        .optional()
        .refine((val) => !val || isValidIP(val), {
          message: "Via IP must be a valid IP address!",
        }),
      z.null(),
    ])
    .optional(),
});

function isValidCIDR(cidr: string): boolean {
  const [ip, prefix] = cidr.split("/");
  const isIPv4 = isValidIP(ip);
  const isIPv6 = isValidIP(ip);
  const prefixNumber = parseInt(prefix);

  if (isIPv4) {
    return prefixNumber >= 0 && prefixNumber <= 32;
  } else if (isIPv6) {
    return prefixNumber >= 0 && prefixNumber <= 128;
  } else {
    return false;
  }
}
const RoutesArraySchema = z.array(RouteSchema);

export const networkRouter = createTRPCRouter({
  getUserNetworks: protectedProcedure.query(async ({ ctx }) => {
    // const test = await centralApi.get_controller_networks();
    // const create = await centralApi.network_detail("83048a0632c0443d");
    // console.log(create)
    const networks = await ctx.prisma.network.findMany({
      where: {
        authorId: ctx.session.user.id,
      },
      include: {
        networkMembers: {
          select: {
            id: true,
          },
        },
      },
    });
    return networks;
  }),

  getNetworkById: protectedProcedure
    .input(
      z.object({
        nwid: z.string(),
        central: z.boolean().optional().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      // Get available cidr options.
      const ipAssignmentPools = IPv4gen(null);
      const { cidrOptions } = ipAssignmentPools;

      if (input.central) {
        const t = await ztController.central_network_detail(
          input.nwid,
          input.central
        );
        // console.log(JSON.stringify(t, null, 2));
        return t;
      }
      const psqlNetworkData = await ctx.prisma.network.findFirst({
        where: {
          AND: [
            {
              authorId: { equals: ctx.session.user.id },
              nwid: { equals: input.nwid },
            },
          ],
        },
        include: {
          networkMembers: false,
        },
      });

      // Only return nw details for author user!
      if (!psqlNetworkData)
        return throwError(`You are not the Author of this network!`);

      // Return nw obj details
      const ztControllerResponse = await ztController
        .local_network_detail(psqlNetworkData.nwid, false)
        .catch((err: APIError) => {
          return throwError(`${err.message}`);
        });

      // console.log(JSON.stringify(ztControllerResponse, null, 2));
      // upate db with new memebers if they not exsist
      await updateNetworkMembers(ztControllerResponse);

      // merge network data from psql and zt controller
      const mergedNetwork = {
        ...psqlNetworkData,
        ...ztControllerResponse?.network,
        cidr: cidrOptions,
      };

      const combined: Partial<NetworkAndMembers> = {
        ...ztControllerResponse,
        network: mergedNetwork as ZtControllerNetwork,
      };
      const { members, network } = combined;

      // Get all members that is deleted but still active in controller (zombies).
      // Due to an issue were not possible to delete user.
      // Updated 08/2022, delete function should work if user is de-autorized prior to deleting.
      const getZombieMembersPromises = members.map(
        async (member: MembersEntity) => {
          return await ctx.prisma.networkMembers.findFirst({
            where: {
              nwid: input.nwid,
              id: member.id,
              deleted: true,
            },
          });
        }
      );

      const getActiveMembers = await ctx.prisma.networkMembers.findMany({
        where: {
          nwid: input.nwid,
          deleted: false,
        },
        include: {
          notations: {
            include: {
              label: true,
            },
          },
        },
      });
      // Get peers to view client version of zt
      const updatedActiveMembers = await Promise.all(
        getActiveMembers.map(async (member: networkMembers) => {
          const peers = (await ztController
            .peer(member?.address)
            .catch(() => [])) as Peers[];

          const memberPeer = peers.find(
            (peer: Peers) => peer.address === member.id
          );
          let activePreferredPath: Paths | undefined;

          if (memberPeer && memberPeer.paths) {
            activePreferredPath = memberPeer.paths.find(
              (path) => path && path.active === true && path.preferred === true
            );
          }

          // Renamed address field of activePreferredPath
          const { address: physicalAddress, ...restOfActivePreferredPath } =
            activePreferredPath || {};

          return {
            ...member,
            peers: {
              ...(memberPeer || {}),
              physicalAddress,
              ...restOfActivePreferredPath,
            },
          };
        })
      );

      // console.log(JSON.stringify(updatedActiveMembers, null, 2));
      // Resolve the promises before passing them to Promise.all
      const zombieMembers = await Promise.all(getZombieMembersPromises);
      // console.log(JSON.stringify(updatedActiveMembers, null, 2));

      // filters out any null or undefined elements in the zombieMembers array.
      const filteredZombieMembers = zombieMembers.filter((a) => a);

      return {
        network,
        members: updatedActiveMembers,
        zombieMembers: filteredZombieMembers,
      };
    }),
  deleteNetwork: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // Delete ZT network
        await ztController.network_delete(input.nwid);

        // Delete networkMembers
        await ctx.prisma.networkMembers.deleteMany({
          where: {
            nwid: input.nwid,
          },
        });

        // Delete network
        await ctx.prisma.network.deleteMany({
          where: {
            authorId: ctx.session.user.id,
            nwid: input.nwid,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return throwError(`Invalid routes provided ${error.message}`);
        } else {
          throw error;
        }
      }
    }),
  enableIpv4AutoAssign: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          v4AssignMode: z.object({
            zt: z.boolean(),
          }),
        }),
      })
    )
    .mutation(async ({ input }) => {
      // if central is true, send the request to the central API and return the response
      if (input.central) {
        return await centralApi.network_update(input.nwid, input.updateParams);
      }

      // update local network
      return ztController.network_update(input.nwid, input.updateParams);
    }),
  easyIpAssignment: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          routes: RoutesArraySchema.optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      // generate network params
      const { ipAssignmentPools, routes, v4AssignMode } = IPv4gen(
        input.updateParams.routes[0].target
      );

      // prepare update params
      const updateParams = input.central
        ? { config: { ipAssignmentPools, routes, v4AssignMode } }
        : { ipAssignmentPools, routes, v4AssignMode };

      // update network
      return ztController.network_update({
        nwid: input.nwid,
        central: input.central,
        updateParams,
      });
    }),
  advancedIpAssignment: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          ipAssignmentPools: z
            .array(
              z.object({
                ipRangeStart: z.string(),
                ipRangeEnd: z.string(),
              })
            )
            .optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      const { ipAssignmentPools } = input.updateParams;
      // prepare update params
      const updateParams = input.central
        ? { config: { ipAssignmentPools } }
        : { ipAssignmentPools };

      // update network
      return ztController.network_update({
        nwid: input.nwid,
        central: input.central,
        updateParams,
      });
    }),
  privatePublicNetwork: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          private: z.boolean().optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      console.log(input);
      const updateParams = input.central
        ? { config: { private: input.updateParams.private } }
        : { private: input.updateParams.private };

      // if central is true, send the request to the central API and return the response
      return ztController.network_update({
        nwid: input.nwid,
        central: input.central,
        updateParams,
      });
    }),

  networkDescription: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          description: z.string().optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      // update either central or local network
      return ztController.network_update({ ...input });
    }),
  updateNetwork: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        central: z.boolean().optional().default(false),
        updateParams: z.object({
          multicastLimit: z.number().optional(),
          enableBroadcast: z.boolean().optional(),
          name: z.string().optional(),
          dns: z
            .object({
              domain: z.string().nonempty().refine(isValidDomain, {
                message: `Invalid DNS domain provided`,
              }),
              servers: z
                .array(
                  z.string().nonempty().refine(isValidIP, {
                    message: `Invalid DNS server provided`,
                  })
                )
                .optional(),
            })
            .optional(),
          changeCidr: z.string().optional(),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Construct the API request payload using the provided updateParams
      const ztControllerUpdates: Partial<ZtControllerNetwork> = {};
      try {
        const { changeCidr } = input.updateParams;

        if (changeCidr) {
          ztControllerUpdates.cidr = IPv4gen(changeCidr).cidrOptions;
        }

        // if central is true, send the request to the central API and return the response
        if (input.central) {
          return await ztController.network_update(
            input.nwid,
            { config: { ...input.updateParams } },
            input.central
          );
        }

        // Update network in prisma
        const prismaUpdatePromise = ctx.prisma.network.update({
          where: { nwid: input.nwid },
          data: {
            ...input.updateParams,
          },
        });

        // Return nw obj details
        // const ztControllerResponse = await ztController
        //   .network_detail(input.nwid)
        //   .catch((err: APIError) => {
        //     return throwError(`${err.message}`);
        //   });

        // if (typeof autoAssignIp === "boolean") {
        //   await handleAutoAssignIP(
        //     autoAssignIp,
        //     ztControllerUpdates,
        //     ztControllerResponse,
        //     input.nwid
        //   );
        // }
        const ztControllerUpdatePromise = ztController.network_update(
          input.nwid,
          input.updateParams
        );

        const [, ztControllerResult] = await Promise.all([
          prismaUpdatePromise,
          ztControllerUpdatePromise,
        ]);
        return ztControllerResult;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throwError(`Something went wrong during update, ${error.message}`);
        } else {
          throw error;
        }
      }
    }),
  createNetwork: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      // Generate ipv4 address, cidr, start & end
      const ipAssignmentPools = IPv4gen(null);

      // Generate adjective and noun word
      const networkName: string = uniqueNamesGenerator(customConfig);

      // Create ZT network
      const newNw = await ztController.network_create(
        networkName,
        ipAssignmentPools,
        false
      );

      // Store the created network in the database
      const updatedUser = await ctx.prisma.user.update({
        where: {
          id: ctx.session.user.id,
        },
        data: {
          network: {
            create: {
              name: newNw.name,
              nwid: newNw.nwid,
              ipAssignments: newNw.routes[0].target,
            },
          },
        },
        select: {
          network: true,
        },
      });
      return updatedUser;
    } catch (err: unknown) {
      if (err instanceof Error) {
        // Log the error and throw a custom error message
        // eslint-disable-next-line no-console
        console.error(err);
        throwError("Could not create network! Please try again");
      } else {
        // Throw a generic error for unknown error types
        throwError("An unknown error occurred");
      }
    }
  }),
  setFlowRule: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        flowRoute: z.string().nonempty(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { flowRoute } = input;

      const rules = [];
      const caps: Record<string, CapabilitiesByName> = {};
      const tags: TagsByName = {};
      // try {
      const err = RuleCompiler(flowRoute, rules, caps, tags) as string[];
      if (err) {
        return throwError(
          JSON.stringify({
            error: `ERROR parsing Flow Rules at line ${err[0]} column ${err[1]}: ${err[2]}`,
            line: err[0],
          })
        );
      }
      const capsArray = [];
      const capabilitiesByName = {};
      for (const n in caps) {
        const cap = caps[n];
        capsArray.push(cap);
        capabilitiesByName[n] = cap.id;
      }

      const tagsArray = [];
      for (const n in tags) {
        const t = tags[n];
        const dfl = t["default"] as unknown;
        tagsArray.push({
          id: t.id,
          default: dfl || dfl === 0 ? dfl : null,
        });
      }
      // console.log(
      //   JSON.stringify(
      //     {
      //       config: {
      //         rules: rules,
      //         capabilities: capsArray,
      //         tags: tagsArray,
      //       },
      //       capabilitiesByName: capabilitiesByName,
      //       tagsByName: tags,
      //     },
      //     null,
      //     2
      //   )
      // );
      // update zerotier network with the new flow route
      await ztController.network_update(input.nwid, {
        rules,
        capabilities: capsArray,
        tags: tagsArray,
        capabilitiesByName: capabilitiesByName,
        tagsByName: tags,
      });

      // update network in prisma
      // update network in prisma
      const { prisma } = ctx;

      // Start a transaction
      await prisma.$transaction([
        // Update network
        prisma.network.update({
          where: { nwid: input.nwid },
          data: {
            flowRule: flowRoute,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
            tagsByName: tags as any,
            capabilitiesByName,
          },
        }),
      ]);
    }),
  getFlowRule: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        reset: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const DEFAULT_NETWORK_ROUTE_CONFIG = `#
# This is a default rule set that allows IPv4 and IPv6 traffic but otherwise
# behaves like a standard Ethernet switch.
#
# Please keep in mind that ZeroTier versions prior to 1.2.0 do NOT support advanced
# network rules.
#
# Since both senders and receivers enforce rules, you will get the following
# behavior in a network with both old and new versions:
#
# (old: 1.1.14 and older, new: 1.2.0 and newer)
#
# old <--> old: No rules are honored.
# old <--> new: Rules work but are only enforced by new side. Tags will NOT work, and
#               capabilities will only work if assigned to the new side.
# new <--> new: Full rules engine support including tags and capabilities.
#
# We recommend upgrading all your devices to 1.2.0 as soon as convenient. Version
# 1.2.0 also includes a significantly improved software update mechanism that is
# turned on by default on Mac and Windows. (Linux and mobile are typically kept up
# to date using package/app management.)
#
#
# Allow only IPv4, IPv4 ARP, and IPv6 Ethernet frames.
#
drop
  not ethertype ipv4
  and not ethertype arp
  and not ethertype ipv6
;
#
# Uncomment to drop non-ZeroTier issued and managed IP addresses.
#
# This prevents IP spoofing but also blocks manual IP management at the OS level and
# bridging unless special rules to exempt certain hosts or traffic are added before
# this rule.
#
#drop
#	not chr ipauth
#;
# Accept anything else. This is required since default is 'drop'.
accept;`;

      const flow = await ctx.prisma.network.findFirst({
        where: { nwid: input.nwid },
      });

      if (!flow.flowRule || input.reset) {
        return DEFAULT_NETWORK_ROUTE_CONFIG;
      }

      return flow.flowRule;
    }),
  inviteUserByMail: protectedProcedure
    .input(
      z.object({
        nwid: z.string().nonempty(),
        email: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { nwid, email } = input;
      const globalOptions = await ctx.prisma.globalOptions.findFirst({
        where: {
          id: 1,
        },
      });

      const defaultTemplate = inviteUserTemplate();
      const template = globalOptions?.inviteUserTemplate ?? defaultTemplate;

      const renderedTemplate = await ejs.render(
        JSON.stringify(template),
        {
          toEmail: email,
          fromName: ctx.session.user.name, // assuming locals contains a 'username'
          nwid, // assuming locals contains a 'username'
        },
        { async: true }
      );
      // create transporter
      const transporter = createTransporter(globalOptions);
      const parsedTemplate = JSON.parse(renderedTemplate) as Record<
        string,
        string
      >;

      // define mail options
      const mailOptions = {
        from: globalOptions.smtpEmail,
        to: ctx.session.user.email,
        subject: parsedTemplate.subject,
        html: parsedTemplate.body,
      };

      // send test mail to user
      await sendEmail(transporter, mailOptions);
    }),
  addAnotation: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        nwid: z.string(),
        nodeid: z.number(),
        color: z.string().optional(),
        description: z.string().optional(),
        showMarkerInTable: z.boolean().optional(),
        useAsTableBackground: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const notation = await ctx.prisma.notation.upsert({
        where: {
          name_nwid: {
            name: input.name,
            nwid: input.nwid,
          },
        },
        update: {},
        create: {
          name: input.name,
          color: input.color,
          description: input.description,
          nwid: input.nwid,
        },
      });

      // link the notation to the network member.
      return await ctx.prisma.networkMemberNotation.upsert({
        where: {
          notationId_nodeid: {
            notationId: notation.id,
            nodeid: input.nodeid,
          },
        },
        update: {},
        create: {
          notationId: notation.id,
          nodeid: input.nodeid,
        },
      });
    }),
  getAnotation: protectedProcedure
    .input(
      z.object({
        nwid: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      return await ctx.prisma.notation.findMany({
        where: {
          nwid: input.nwid,
        },
      });
    }),
});
