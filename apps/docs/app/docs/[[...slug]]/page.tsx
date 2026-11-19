import { notFound } from "next/navigation";
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { OperationItem } from "fumadocs-openapi";
import { source, openapi } from "@/lib/source";
import { PageActions } from "@/components/PageActions";
import { OpenAPIPage } from "@/components/OpenAPIPage";

const DEFAULT_SCHEMA_ID = "./public/openapi.json";

interface APIPageMdxProps {
  document?: string;
  operations?: OperationItem[];
}

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = params.slug && params.slug.length > 0 ? params.slug.join("/") : "index";
  const { bundled } = await openapi.getSchema(DEFAULT_SCHEMA_ID);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <PageActions slug={slugStr} title={page.data.title} />
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
            APIPage: (apiProps: APIPageMdxProps) => (
              <OpenAPIPage
                document={apiProps.document ?? DEFAULT_SCHEMA_ID}
                operations={apiProps.operations}
                payload={{ bundled }}
              />
            ),
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}
