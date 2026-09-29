import { Body, Container, Head, Heading, Html, Preview, Text } from "react-email";

type NotificationEmailProps = {
  title: string;
  message: string;
};

export function NotificationEmail({ title, message }: NotificationEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{title}</Preview>
      <Body style={{ backgroundColor: "#edf0f6", fontFamily: "Arial, sans-serif" }}>
        <Container style={{ margin: "32px auto", padding: "24px", backgroundColor: "#ffffff" }}>
          <Heading style={{ color: "#081f49", fontSize: "22px", borderBottom: "3px solid #f2c400", paddingBottom: "12px" }}>
            {title}
          </Heading>
          {message.split(/\r?\n/).map((line, index) => (
            <Text key={index} style={{ color: "#334155", fontSize: "16px", lineHeight: "24px" }}>
              {line || " "}
            </Text>
          ))}
        </Container>
      </Body>
    </Html>
  );
}
