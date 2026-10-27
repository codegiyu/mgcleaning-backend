import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from "react-email";
import { isSafeActionHref, type EmailAction } from "./alert-actions.js";

type NotificationEmailProps = {
  title: string;
  message: string;
  /** Shown as buttons above the details so they can be tapped first on a phone. */
  actions?: EmailAction[];
};

export function NotificationEmail({ title, message, actions = [] }: NotificationEmailProps) {
  const buttons = actions.filter((action) => isSafeActionHref(action.href));
  return (
    <Html lang="en">
      <Head />
      <Preview>{title}</Preview>
      <Body style={{ backgroundColor: "#edf0f6", fontFamily: "Arial, sans-serif" }}>
        <Container style={{ margin: "32px auto", padding: "24px", backgroundColor: "#ffffff" }}>
          <Heading style={{ color: "#081f49", fontSize: "22px", borderBottom: "3px solid #f2c400", paddingBottom: "12px" }}>
            {title}
          </Heading>
          {buttons.length > 0 && (
            <Section style={{ margin: "8px 0 16px" }}>
              {buttons.map((action, index) => (
                <Button
                  key={action.href}
                  href={action.href}
                  style={{
                    display: "inline-block",
                    margin: "0 8px 8px 0",
                    padding: "12px 18px",
                    borderRadius: "6px",
                    backgroundColor: index === 0 ? "#f2c400" : "#081f49",
                    color: index === 0 ? "#081f49" : "#ffffff",
                    fontSize: "15px",
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </Section>
          )}
          {message.split(/\r?\n/).map((line, index) => (
            <Text key={index} style={{ color: "#334155", fontSize: "16px", lineHeight: "24px" }}>
              {line || " "}
            </Text>
          ))}
        </Container>
      </Body>
    </Html>
  );
}
